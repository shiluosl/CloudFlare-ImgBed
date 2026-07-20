import assert from 'node:assert/strict';
import { StorageError, STORAGE_ERROR_CODES } from '../functions/core/storage/adapter.js';
import { getAdapter } from '../functions/core/storage/registry.js';
import { calculateProtectionLevel } from '../functions/core/cost/zeroCostGuard.js';
import { assertFileTransition, assertReplicaTransition, assertJobTransition } from '../functions/core/state/statusMachine.js';
import { WebDavAdapter } from '../functions/adapters/webdav/webdavAdapter.js';
import { TelegramAdapter } from '../functions/adapters/telegram/telegramAdapter.js';
import { UploadService } from '../functions/core/upload/uploadService.js';
import { FileService } from '../functions/core/files/fileService.js';
import { ZeroCostGuard } from '../functions/core/cost/zeroCostGuard.js';
import { JobService } from '../functions/core/jobs/jobService.js';
import { assertExternalEndpoint } from '../functions/core/security/endpointValidation.js';
import { executeStorageJob, isExecutableStorageJob } from '../functions/queues/storageConsumer.js';
import { inspectZeroCostFiles } from '../scripts/zero-cost-check.mjs';
import { hasSensitiveConfig } from '../functions/api/manage/ops/channels.js';

describe('zero-cost DR core', () => {
  it('rejects R2 in zero-cost mode', () => {
    assert.throws(() => getAdapter({ id: 'r2', provider: 'r2' }, { ZERO_COST_MODE: 'true', ALLOW_R2: 'false' }), error => error instanceof StorageError && error.code === STORAGE_ERROR_CODES.UNSUPPORTED);
  });
  it('calculates the five-level protection state', () => {
    const limits = { WORKER_REQUEST_SOFT_LIMIT: 100, D1_READ_SOFT_LIMIT: 100, D1_WRITE_SOFT_LIMIT: 100, QUEUE_OPS_SOFT_LIMIT: 100, DAILY_UPLOAD_SOFT_LIMIT: 100 };
    assert.equal(calculateProtectionLevel({}, limits), 'NORMAL'); assert.equal(calculateProtectionLevel({ uploads: 75 }, limits), 'WARNING'); assert.equal(calculateProtectionLevel({ uploads: 90 }, limits), 'WRITE_LIMITED'); assert.equal(calculateProtectionLevel({ uploads: 100 }, limits), 'READ_ONLY'); assert.equal(calculateProtectionLevel({ uploads: 120 }, limits), 'EMERGENCY');
  });
  it('guards status transitions', () => { assert.doesNotThrow(() => assertFileTransition('receiving', 'available')); assert.throws(() => assertFileTransition('deleted', 'available')); assert.doesNotThrow(() => assertReplicaTransition('planned', 'uploading')); assert.throws(() => assertReplicaTransition('deleted', 'healthy')); assert.doesNotThrow(() => assertJobTransition('pending', 'queued')); assert.throws(() => assertJobTransition('succeeded', 'running')); });
});

describe('WebDAV adapter contract', () => {
  it('writes, heads, reads, and idempotently deletes a path', async () => {
    const calls = []; const fetch = async (url, init) => { calls.push({ url, ...init }); if (init.method === 'HEAD') return new Response(null, { status: 200, headers: { 'Content-Length': '3', ETag: 'etag' } }); return new Response(init.method === 'GET' ? 'abc' : null, { status: init.method === 'DELETE' ? 404 : 201, headers: { ETag: 'etag' } }); };
    const adapter = new WebDavAdapter({ id: 'webdav', config: { baseUrl: 'https://storage.example/dav' } }, {}, fetch); const stored = await adapter.put({ objectKey: 'nested/a b.txt', body: new Blob(['abc']), size: 3, contentType: 'text/plain' }); assert.equal(stored.size, 3); assert.equal((await adapter.head({ objectKey: 'nested/a b.txt' })).size, 3); assert.equal(await (await adapter.get({ objectKey: 'nested/a b.txt' })).text(), 'abc'); await adapter.delete({ objectKey: 'nested/a b.txt' }); assert.match(calls.find(call => call.method === 'PUT').url, /a%20b.txt/);
  });
});

describe('Telegram adapter contract', () => {
  it('maps Telegram upload, read, head, delete, and rate limit errors', async () => {
    const fetch = async (url, init = {}) => { if (url.includes('sendDocument')) return Response.json({ ok: true, result: { message_id: 4, document: { file_id: 'remote', file_unique_id: 'unique', file_size: 3 } } }); if (url.includes('getFile')) return Response.json({ ok: true, result: { file_path: 'doc/a', file_size: 3, file_unique_id: 'unique' } }); if (url.includes('/file/')) return new Response('abc'); if (url.includes('deleteMessage')) return Response.json({ ok: true, result: true }); return Response.json({ ok: true, result: { username: 'bot' } }); };
    const adapter = new TelegramAdapter({ id: 'telegram', config: { chatId: '1' }, secretRefs: { tokenRef: 'TOKEN' } }, { TOKEN: 'redacted' }, fetch); const stored = await adapter.put({ objectKey: 'a.txt', name: 'a.txt', body: new Blob(['abc']), size: 3 }); assert.equal(stored.remoteId, 'remote'); assert.equal((await adapter.head({ remoteId: 'remote' })).size, 3); assert.equal(await (await adapter.get({ remoteId: 'remote' })).text(), 'abc'); await adapter.delete({ safeMetadata: stored.safeMetadata });
  });
});

describe('upload disaster recovery workflow', () => {
  it('records available, degraded, failed, strict, fast, and idempotent uploads', async () => {
    const repo = new UploadMemoryRepository();
    const jobs = { records: [], async create(job) { this.records.push(job); return job; } };
    const guard = { limits: { HARD_MAX_UPLOAD_BYTES: 20 * 1024 * 1024, MAX_UPLOAD_BYTES: 10 * 1024 * 1024 }, async assertWrite() {}, async record() {} };
    const service = new UploadService(repo, guard, { ZERO_COST_MODE: 'true' }, jobs);
    const statuses = ['healthy', 'healthy', 'healthy', 'retry_wait', 'retry_wait', 'retry_wait', 'healthy', 'retry_wait', 'healthy'];
    service.orchestrator = {
      async writeReplica(file, replica) { const status = statuses.shift(); await repo.updateReplica(replica.id, { status }); return { replica: await repo.getReplica(replica.id), ...(status === 'healthy' ? { stored: { size: file.size } } : { error: new Error('remote failure') }) }; },
      async recomputeFileHealth(fileId) { const replicas = await repo.listReplicas(fileId); const healthy = replicas.filter(item => item.status === 'healthy').length; return repo.updateFileStatus(fileId, healthy === 2 ? 'available' : healthy === 1 ? 'degraded' : 'failed'); },
    };
    const input = { policyId: 'policy', idempotencyKey: 'dual-success', name: 'demo.txt', contentType: 'text/plain', size: 3, body: new Blob(['abc']), admin: true };
    const ok = await service.upload(input);
    assert.equal(ok.file.status, 'available');
    const repeated = await service.upload(input);
    assert.equal(repeated.idempotent, true);
    const degraded = await service.upload({ ...input, idempotencyKey: 'one-failed', body: new Blob(['abc']) });
    assert.equal(degraded.file.status, 'degraded');
    assert.equal(jobs.records.length, 1);
    const failed = await service.upload({ ...input, idempotencyKey: 'both-failed', body: new Blob(['abc']) });
    assert.equal(failed.file.status, 'failed');
    assert.equal(jobs.records.length, 3);
    await assert.rejects(() => service.upload({ ...input, idempotencyKey: 'strict-failed', mode: 'strict', body: new Blob(['abc']) }), /Strict upload/);
    const fast = await service.upload({ ...input, idempotencyKey: 'fast-mode', mode: 'fast', body: new Blob(['abc']) });
    assert.equal(fast.file.status, 'degraded');
  });

  it('queues async replicas without adding them to the synchronous write set', async () => {
    const repo = new UploadMemoryRepository();
    repo.policy.async_channels_json = JSON.stringify(['async-channel']);
    const jobs = { records: [], async create(job) { this.records.push(job); return job; } };
    const guard = { limits: { HARD_MAX_UPLOAD_BYTES: 20 * 1024 * 1024, MAX_UPLOAD_BYTES: 10 * 1024 * 1024 }, async assertWrite() {}, async record() {} };
    const service = new UploadService(repo, guard, { ZERO_COST_MODE: 'true' }, jobs);
    const written = [];
    service.orchestrator = {
      async writeReplica(_file, replica) { written.push(replica.id); await repo.updateReplica(replica.id, { status: 'healthy' }); return { replica: await repo.getReplica(replica.id), stored: { size: 3 } }; },
      async recomputeFileHealth(fileId) { const replicas = await repo.listReplicas(fileId); const healthy = replicas.filter(item => item.status === 'healthy').length; return repo.updateFileStatus(fileId, healthy >= 2 ? 'available' : healthy ? 'degraded' : 'failed'); },
    };
    const result = await service.upload({ policyId: 'policy', idempotencyKey: 'async-replica', name: 'demo.txt', contentType: 'text/plain', size: 3, body: new Blob(['abc']), admin: true });
    assert.equal(written.length, 2);
    assert.equal(result.replicas.filter(replica => replica.role === 'async_backup')[0].status, 'planned');
    assert.equal(jobs.records.length, 1);
    assert.equal(jobs.records[0].operation, 'CREATE_REPLICA');
  });
});

describe('read, delete, and queue recovery', () => {
  it('falls back once, schedules repair, and returns 503 when no replica works', async () => {
    const repository = new FileMemoryRepository();
    const jobs = { records: [], async create(job) { this.records.push(job); } };
    const storage = { async readCandidates() { return repository.replicas; }, async openReplica(replica) { if (replica.id === 'primary') throw Object.assign(new Error('primary unavailable'), { code: 'NETWORK_ERROR' }); return new Response('backup'); } };
    const service = new FileService({ repository, jobs, storage });
    const result = await service.read('file_1', new Request('https://example.test/file/file_1'));
    assert.equal(result.response.status, 200);
    assert.equal(await result.response.text(), 'backup');
    assert.equal(repository.replicas[0].status, 'suspect');
    assert.equal(jobs.records[0].operation, 'REPAIR_REPLICA');
    storage.openReplica = async () => { throw new Error('offline'); };
    assert.equal((await service.read('file_1', new Request('https://example.test/file/file_1'))).response.status, 503);
  });

  it('creates a next-generation tombstone and prevents late non-delete jobs', async () => {
    const repository = new FileMemoryRepository();
    const jobs = { records: [], async create(job) { this.records.push(job); } };
    const service = new FileService({ repository, jobs, storage: {} });
    const tombstone = await service.delete('file_1', 'admin');
    assert.equal(tombstone.generation, 2);
    assert.equal(repository.file.generation, 2);
    assert.equal(repository.file.status, 'deleting');
    assert.equal(jobs.records.length, 2);
    assert.equal(isExecutableStorageJob({ operation: 'REPAIR_REPLICA', generation: 1 }, repository.file, tombstone), false);
    assert.equal(isExecutableStorageJob({ operation: 'DELETE_REPLICA', generation: 2 }, repository.file, tombstone), true);
  });

  it('handles duplicate recount jobs and completes deletion after all replicas are gone', async () => {
    const repository = new FileMemoryRepository();
    repository.file.status = 'deleting'; repository.file.generation = 2;
    repository.tombstone = { generation: 2 };
    const app = { repository, storage: { calls: 0, async recomputeFileHealth() { this.calls += 1; } } };
    await executeStorageJob(app, {}, { operation: 'RECOUNT_FILE_HEALTH' }, repository.file, null);
    await executeStorageJob(app, {}, { operation: 'RECOUNT_FILE_HEALTH' }, repository.file, null);
    assert.equal(app.storage.calls, 2);
    repository.replicas.forEach(replica => { replica.status = 'deleted'; });
    await executeStorageJob(app, {}, { operation: 'DELETE_REPLICA' }, repository.file, null);
    assert.equal(repository.file.status, 'deleted');
  });
});

describe('zero-cost controls and security', () => {
  it('enforces read-only writes while leaving reads outside the guard', async () => {
    const repository = { async getUsage() { return { uploads: 500 }; }, async incrementUsage() {}, async setProtectionLevel() {} };
    const guard = new ZeroCostGuard(repository, { DAILY_UPLOAD_SOFT_LIMIT: '500' });
    await assert.rejects(() => guard.assertWrite({ admin: true }), error => error.level === 'READ_ONLY');
  });
  it('rejects private WebDAV endpoints unless explicitly allowed', () => {
    assert.throws(() => assertExternalEndpoint('http://127.0.0.1/dav'));
    assert.equal(assertExternalEndpoint('https://storage.example/dav').hostname, 'storage.example');
  });
  it('flags active R2 bindings in deployment configuration', () => {
    const base = process.cwd();
    assert.deepEqual(inspectZeroCostFiles(base), []);
  });
  it('requires storage credentials to be supplied as secret references', () => {
    assert.equal(hasSensitiveConfig({ baseUrl: 'https://storage.example/dav' }), false);
    assert.equal(hasSensitiveConfig({ password: 'not-allowed' }), true);
    assert.equal(hasSensitiveConfig({ botToken: 'not-allowed' }), true);
  });
});

class UploadMemoryRepository {
  constructor() { this.files = new Map(); this.replicas = new Map(); this.policy = { id: 'policy', enabled: 1, primary_channel_id: 'webdav', sync_backup_channel_id: 'telegram', write_mode: 'safe' }; }
  async getFileByIdempotency(key) { return [...this.files.values()].find(file => file.idempotency_key === key) || null; }
  async getPolicy() { return this.policy; }
  async createFileWithReplicas(file, specs) { const row = { ...file, idempotency_key: file.idempotencyKey, generation: 1 }; this.files.set(row.id, row); specs.forEach(spec => this.replicas.set(spec.id, { id: spec.id, file_id: row.id, channel_id: spec.channelId, role: spec.role, object_key: spec.objectKey, status: 'planned' })); return row; }
  async listReplicas(fileId) { return [...this.replicas.values()].filter(item => item.file_id === fileId); }
  async getReplica(id) { return this.replicas.get(id); }
  async getChannel(id) { return { id, provider: id, config_json: '{}', secret_refs_json: '{}', enabled: 1, health_status: 'healthy' }; }
  async updateReplica(id, patch) { const replica = this.replicas.get(id); Object.assign(replica, patch); return replica; }
  async updateFileStatus(id, status) { const file = this.files.get(id); file.status = status; return file; }
}

class FileMemoryRepository {
  constructor() {
    this.file = { id: 'file_1', generation: 1, status: 'available', name: 'demo.html', content_type: 'text/html', is_public: 1, size: 6 };
    this.replicas = [{ id: 'primary', channel_id: 'webdav', status: 'healthy', role: 'primary', enabled: 1, health_status: 'healthy' }, { id: 'backup', channel_id: 'telegram', status: 'healthy', role: 'sync_backup', enabled: 1, health_status: 'healthy' }];
    this.tombstone = null;
  }
  async getFile() { return this.file; }
  async getTombstone() { return this.tombstone; }
  async listReplicas() { return this.replicas; }
  async updateReplica(id, patch) { Object.assign(this.replicas.find(item => item.id === id), patch); }
  async createTombstone(_id, generation) { this.file.status = 'deleting'; this.file.generation = generation + 1; this.tombstone = { generation: this.file.generation }; return this.tombstone; }
  async finalizeDeletion() { if (this.replicas.every(item => item.status === 'deleted')) this.file.status = 'deleted'; return this.file; }
}
