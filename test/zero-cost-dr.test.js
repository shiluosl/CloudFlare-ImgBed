import assert from 'node:assert/strict';
import { StorageError, STORAGE_ERROR_CODES } from '../functions/core/storage/adapter.js';
import { getAdapter } from '../functions/core/storage/registry.js';
import { effectiveChannelCapabilities } from '../functions/core/storage/capabilities.js';
import { calculateProtectionLevel } from '../functions/core/cost/zeroCostGuard.js';
import { d1ReadsPerSampledV3Request, recordWorkerRequestEstimate, shouldEstimateWorkerRequest, workerRequestSampleRate } from '../functions/core/cost/requestMeter.js';
import { assertFileTransition, assertReplicaTransition, assertJobTransition } from '../functions/core/state/statusMachine.js';
import { WebDavAdapter } from '../functions/adapters/webdav/webdavAdapter.js';
import { TelegramAdapter } from '../functions/adapters/telegram/telegramAdapter.js';
import { S3Adapter } from '../functions/adapters/s3/s3Adapter.js';
import { UploadService } from '../functions/core/upload/uploadService.js';
import { FileService } from '../functions/core/files/fileService.js';
import { ZeroCostGuard } from '../functions/core/cost/zeroCostGuard.js';
import { JobService } from '../functions/core/jobs/jobService.js';
import { assertExternalEndpoint } from '../functions/core/security/endpointValidation.js';
import { executeStorageJob, isExecutableStorageJob } from '../functions/queues/storageConsumer.js';
import { inspectZeroCostFiles } from '../scripts/zero-cost-check.mjs';
import { hasSensitiveConfig, validSecretRefs, validateChannelConfig } from '../functions/api/manage/ops/channels.js';
import { ChannelHealthService } from '../functions/core/health/channelHealthService.js';
import { selectRotatingCriticalReplicaMaintenance, selectRotatingHealthCheckChannels, selectRotatingReplicaMaintenance, scheduleReplicaMaintenance } from '../functions/scheduled/maintenance.js';
import { onRequestPatch as patchChannel } from '../functions/api/manage/ops/channels.js';
import { onRequestPost as createPolicy, validatePolicy } from '../functions/api/manage/ops/policies.js';
import { v3ReadEnabled, v3UploadEnabled } from '../functions/core/config.js';
import { StorageOrchestrator } from '../functions/core/storage/orchestrator.js';
import { uploadFiles } from '../functions/api/manage/ops/upload.js';
import { tryReadV3File } from '../functions/core/files/v3ReadDispatch.js';
import { authorizePrivateV3Read } from '../functions/core/security/privateFileAccess.js';
import { visibleUploadChannels } from '../functions/api/channels.js';
import { isLegacyR2ChannelForbidden } from '../functions/core/security/zeroCostLegacyGuard.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('zero-cost DR core', () => {
  it('rejects R2 in zero-cost mode', () => {
    assert.throws(() => getAdapter({ id: 'r2', provider: 'r2' }, { ZERO_COST_MODE: 'true', ALLOW_R2: 'false' }), error => error instanceof StorageError && error.code === STORAGE_ERROR_CODES.UNSUPPORTED);
  });
  it('calculates the five-level protection state', () => {
    const limits = { WORKER_REQUEST_SOFT_LIMIT: 100, D1_READ_SOFT_LIMIT: 100, D1_WRITE_SOFT_LIMIT: 100, QUEUE_OPS_SOFT_LIMIT: 100, DAILY_UPLOAD_SOFT_LIMIT: 100 };
    assert.equal(calculateProtectionLevel({}, limits), 'NORMAL'); assert.equal(calculateProtectionLevel({ uploads: 75 }, limits), 'WARNING'); assert.equal(calculateProtectionLevel({ uploads: 90 }, limits), 'WRITE_LIMITED'); assert.equal(calculateProtectionLevel({ uploads: 100 }, limits), 'READ_ONLY'); assert.equal(calculateProtectionLevel({ uploads: 120 }, limits), 'EMERGENCY');
  });
  it('uses bounded sampled request estimates instead of a D1 write per request', async () => {
    assert.equal(workerRequestSampleRate({}), 100);
    assert.equal(workerRequestSampleRate({ WORKER_REQUEST_SAMPLE_RATE: '0' }), 1);
    assert.equal(d1ReadsPerSampledV3Request({}), 3);
    assert.equal(d1ReadsPerSampledV3Request({ D1_READS_PER_SAMPLED_V3_REQUEST: '0' }), 1);
    assert.equal(shouldEstimateWorkerRequest('any-v3-request', { WORKER_REQUEST_SAMPLE_RATE: '1' }), true);
    const records = [];
    const recorded = await recordWorkerRequestEstimate({ WORKER_REQUEST_SAMPLE_RATE: '7' }, 'sampled-request', () => ({ guard: { async record(change) { records.push(change); } } }));
    assert.equal(recorded, shouldEstimateWorkerRequest('sampled-request', { WORKER_REQUEST_SAMPLE_RATE: '7' }));
    if (recorded) assert.deepEqual(records, [{ worker_requests: 7, d1_reads: 21 }]);
    else assert.deepEqual(records, []);
  });
  it('guards status transitions while allowing controlled recovery', () => { assert.doesNotThrow(() => assertFileTransition('receiving', 'available')); assert.doesNotThrow(() => assertFileTransition('failed', 'available')); assert.throws(() => assertFileTransition('deleted', 'available')); assert.doesNotThrow(() => assertReplicaTransition('planned', 'uploading')); assert.doesNotThrow(() => assertReplicaTransition('missing', 'healthy')); assert.throws(() => assertReplicaTransition('deleted', 'healthy')); assert.doesNotThrow(() => assertJobTransition('pending', 'queued')); assert.throws(() => assertJobTransition('succeeded', 'running')); });
  it('supports independent V3 read and upload rollback flags', () => {
    assert.equal(v3ReadEnabled({ ENABLE_REPLICATION_V3: 'true', ENABLE_V3_READ: 'false' }), false);
    assert.equal(v3UploadEnabled({ ENABLE_REPLICATION_V3: 'true', ENABLE_V3_UPLOAD: 'false' }), false);
    assert.equal(v3ReadEnabled({ ENABLE_REPLICATION_V3: 'false', ENABLE_V3_READ: 'true' }), false);
  });
  it('keeps an existing V3 logical file authoritative when its read service fails', async () => {
    const request = new Request('https://example.test/file/file_v3');
    const existingFile = { id: 'file_v3', status: 'available' };
    const unavailable = await tryReadV3File(
      { env: { DB: {} }, fileId: 'file_v3', request },
      {
        createRuntime: () => ({ repository: { async getFile() { return existingFile; } } }),
        createFileService: () => ({ async read() { throw Object.assign(new Error('adapter failed'), { code: 'NETWORK_ERROR' }); } }),
        authorizePrivateRead: async () => true,
      },
    );
    assert.equal(unavailable.status, 503);
    assert.equal(await unavailable.text(), 'File temporarily unavailable');

    const legacyFallback = await tryReadV3File(
      { env: { DB: {} }, fileId: 'legacy', request },
      { createRuntime: () => ({ repository: { async getFile() { throw new Error('no such table: files_v3'); } } }) },
    );
    assert.equal(legacyFallback, null);
  });
  it('defaults private V3 reads to a non-enumerating denial without configured authentication', async () => {
    const request = new Request('https://example.test/file/private-file');
    let readCalls = 0;
    const response = await tryReadV3File(
      { env: { DB: {} }, fileId: 'private-file', request },
      {
        createRuntime: () => ({ repository: { async getFile() { return { id: 'private-file', is_public: 0 }; } } }),
        createFileService: () => ({ async read() { readCalls += 1; return { response: new Response('unexpected') }; } }),
        authorizePrivateRead: input => authorizePrivateV3Read({
          ...input,
          fetchSecurityConfigFn: async () => ({ auth: { user: { authCode: '' }, admin: { adminUsername: '', adminPassword: '' } } }),
          validateApiTokenFn: async () => ({ valid: false }),
          getDatabaseFn: () => ({}),
        }),
      },
    );
    assert.equal(response.status, 404);
    assert.equal(readCalls, 0);
  });
  it('allows authenticated private V3 reads and keeps public reads authentication-free', async () => {
    const request = new Request('https://example.test/file/file_1');
    const privateFile = { id: 'file_1', is_public: 0 };
    const authorized = await tryReadV3File(
      { env: { DB: {} }, fileId: 'file_1', request },
      {
        createRuntime: () => ({ repository: { async getFile() { return privateFile; } } }),
        createFileService: () => ({ async read() { return { response: new Response('private', { headers: { 'Cache-Control': 'private, no-store' } }) }; } }),
        authorizePrivateRead: input => authorizePrivateV3Read({
          ...input,
          fetchSecurityConfigFn: async () => ({ auth: { user: { authCode: 'configured' }, admin: { adminUsername: '', adminPassword: '' } } }),
          authenticateFn: async () => ({ authorized: true, authType: 'user' }),
        }),
      },
    );
    assert.equal(authorized.status, 200);
    assert.equal(authorized.headers.get('Cache-Control'), 'private, no-store');

    let securityConfigCalls = 0;
    const publicResponse = await tryReadV3File(
      { env: { DB: {} }, fileId: 'file_1', request },
      {
        createRuntime: () => ({ repository: { async getFile() { return { id: 'file_1', is_public: 1 }; } } }),
        createFileService: () => ({ async read() { return { response: new Response('public') }; } }),
        authorizePrivateRead: input => authorizePrivateV3Read({
          ...input,
          fetchSecurityConfigFn: async () => { securityConfigCalls += 1; return {}; },
        }),
      },
    );
    assert.equal(publicResponse.status, 200);
    assert.equal(securityConfigCalls, 0);
  });
  it('keeps V3 logical-file reads out of the shared Worker Cache path', () => {
    const template = readFileSync('deploy/worker/generate-routes.js', 'utf8');
    assert.match(template, /function isV3LogicalFilePath\(pathname\)/);
    assert.match(template, /if \(isV3LogicalFilePath\(new URL\(request\.url\)\.pathname\)\)/);
  });
  it('hides and rejects historical R2 upload paths in zero-cost mode', () => {
    const uploadConfig = {
      telegram: { channels: [{ name: 'telegram' }] },
      cfr2: { channels: [{ name: 'r2' }] },
      s3: { channels: [{ name: 's3' }] },
      discord: { channels: [] },
      huggingface: { channels: [] },
      webdav: { channels: [{ name: 'webdav' }] },
    };
    const zeroCost = visibleUploadChannels(uploadConfig, { ZERO_COST_MODE: 'true' });
    assert.equal(Object.hasOwn(zeroCost, 'cfr2'), false);
    assert.equal(visibleUploadChannels(uploadConfig, { ZERO_COST_MODE: 'false' }).cfr2.length, 1);
    assert.equal(isLegacyR2ChannelForbidden({ ZERO_COST_MODE: 'true' }, 'cfr2'), true);
    assert.equal(isLegacyR2ChannelForbidden({ ZERO_COST_MODE: 'false' }, 'cfr2'), false);
    assert.equal(isLegacyR2ChannelForbidden({ ZERO_COST_MODE: 'true' }, 'telegram'), false);
  });
  it('only lets channel configuration narrow adapter capabilities', () => {
    const telegram = effectiveChannelCapabilities({ provider: 'telegram', capabilities_json: '{"write":false,"checksum":true,"maxObjectSize":1024}' });
    assert.equal(telegram.write, false);
    assert.equal(telegram.checksum, false);
    assert.equal(telegram.maxObjectSize, 1024);
    assert.equal(effectiveChannelCapabilities({ provider: 'webdav', capabilities_json: '{"maxObjectSize":999999999}' }).maxObjectSize, 999999999);
    assert.equal(effectiveChannelCapabilities({ provider: 'telegram', capabilities_json: '{"maxObjectSize":999999999}' }).maxObjectSize, 20 * 1024 * 1024);
  });
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

  it('treats an already deleted Telegram message as a successful delete', async () => {
    const fetch = async url => url.includes('deleteMessage')
      ? Response.json({ ok: false, description: 'Bad Request: message to delete not found' })
      : Response.json({ ok: true, result: { username: 'bot' } });
    const adapter = new TelegramAdapter({ id: 'telegram', config: { chatId: '1' }, secretRefs: { tokenRef: 'TOKEN' } }, { TOKEN: 'redacted' }, fetch);
    await assert.doesNotReject(() => adapter.delete({ safeMetadata: { messageId: '4' } }));
  });
});

describe('S3-compatible adapter contract', () => {
  it('streams put, get, head, delete, and health checks through the common contract', async () => {
    const commands = [];
    const client = { async send(command) {
      commands.push(command);
      if (command.constructor.name === 'GetObjectCommand') return { Body: new Blob(['abc']), ContentLength: 3, ContentType: 'text/plain', ETag: 'etag' };
      if (command.constructor.name === 'HeadObjectCommand') return { ContentLength: 3, ETag: 'etag', ChecksumSHA256: 'checksum' };
      if (command.constructor.name === 'PutObjectCommand') return { ETag: 'etag', ChecksumSHA256: 'checksum' };
      return { $metadata: { httpStatusCode: 200 } };
    } };
    const adapter = new S3Adapter({ id: 's3', config: { endpoint: 'https://s3.example.test', bucketName: 'imgbed-backups', region: 'auto' }, secretRefs: { accessKeyIdRef: 'S3_ACCESS_KEY_ID', secretAccessKeyRef: 'S3_SECRET_ACCESS_KEY' } }, {}, () => client);
    const stored = await adapter.put({ objectKey: 'a.txt', body: new Blob(['abc']), size: 3, contentType: 'text/plain' });
    assert.equal(stored.etag, 'etag');
    assert.equal((await adapter.head({ objectKey: 'a.txt' })).checksum, 'checksum');
    assert.equal(await (await adapter.get({ objectKey: 'a.txt' })).text(), 'abc');
    await adapter.delete({ objectKey: 'a.txt' });
    await adapter.healthCheck();
    assert.deepEqual(commands.map(command => command.constructor.name), ['PutObjectCommand', 'HeadObjectCommand', 'GetObjectCommand', 'DeleteObjectCommand', 'HeadBucketCommand']);
  });

  it('maps S3 missing objects, credentials, and unsafe endpoint configuration', async () => {
    const missingClient = { async send() { throw Object.assign(new Error('missing'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }); } };
    const channel = { id: 's3', config: { endpoint: 'https://s3.example.test', bucketName: 'imgbed-backups' }, secretRefs: { accessKeyIdRef: 'S3_ACCESS_KEY_ID', secretAccessKeyRef: 'S3_SECRET_ACCESS_KEY' } };
    const adapter = new S3Adapter(channel, {}, () => missingClient);
    await assert.doesNotReject(() => adapter.delete({ objectKey: 'gone.txt' }));
    assert.throws(() => new S3Adapter({ ...channel, config: { ...channel.config, endpoint: 'http://127.0.0.1:9000' } }, { S3_ACCESS_KEY_ID: 'id', S3_SECRET_ACCESS_KEY: 'secret' }).clientForChannel(), error => error.code === STORAGE_ERROR_CODES.INVALID_CONFIGURATION);
    assert.equal(validSecretRefs('s3', channel.secretRefs), true);
    assert.equal(validSecretRefs('s3', { accessKeyIdRef: 'S3_ACCESS_KEY_ID' }), false);
    assert.doesNotThrow(() => validateChannelConfig('s3', channel.config));
  });

  it('rejects private S3 and WebDAV endpoints even when legacy bypass config is present', () => {
    const s3Channel = { id: 's3-private', config: { endpoint: 'http://127.0.0.1:9000', bucketName: 'imgbed-backups', allowPrivateEndpoint: true }, secretRefs: { accessKeyIdRef: 'S3_ACCESS_KEY_ID', secretAccessKeyRef: 'S3_SECRET_ACCESS_KEY' } };
    assert.throws(() => validateChannelConfig('s3', s3Channel.config), /allowPrivateEndpoint/);
    assert.throws(() => new S3Adapter(s3Channel, { S3_ACCESS_KEY_ID: 'id', S3_SECRET_ACCESS_KEY: 'secret' }).clientForChannel(), error => error.code === STORAGE_ERROR_CODES.INVALID_CONFIGURATION);
    assert.throws(() => validateChannelConfig('webdav', { baseUrl: 'http://127.0.0.1/dav', allowPrivateEndpoint: true }), /allowPrivateEndpoint/);
    assert.throws(() => new WebDavAdapter({ id: 'webdav-private', config: { baseUrl: 'http://127.0.0.1/dav', allowPrivateEndpoint: true } }, {}).objectUrl('file.txt'), error => error.code === STORAGE_ERROR_CODES.INVALID_CONFIGURATION);
  });
});

describe('upload disaster recovery workflow', () => {
  it('records available, degraded, failed, strict, fast, and idempotent uploads', async () => {
    const repo = new UploadMemoryRepository();
    const jobs = { records: [], async create(job) { this.records.push(job); return job; } };
    const usageRecords = [];
    const guard = { limits: { HARD_MAX_UPLOAD_BYTES: 20 * 1024 * 1024, MAX_UPLOAD_BYTES: 10 * 1024 * 1024, MAX_SYNC_CHANNELS: 2 }, async assertWrite() {}, async assertRepair() {}, async assertAsyncReplica() {}, async record(change) { usageRecords.push(change); } };
    const service = new UploadService(repo, guard, { ZERO_COST_MODE: 'true' }, jobs);
    const statuses = ['healthy', 'healthy', 'healthy', 'retry_wait', 'retry_wait', 'retry_wait', 'healthy', 'retry_wait', 'healthy'];
    service.orchestrator = {
      async writeReplica(file, replica) { const status = statuses.shift(); await repo.updateReplica(replica.id, { status }); return { replica: await repo.getReplica(replica.id), ...(status === 'healthy' ? { stored: { size: file.size } } : { error: new Error('remote failure') }) }; },
      async recomputeFileHealth(fileId) { const replicas = await repo.listReplicas(fileId); const healthy = replicas.filter(item => item.status === 'healthy').length; return repo.updateFileStatus(fileId, healthy === 2 ? 'available' : healthy === 1 ? 'degraded' : 'failed'); },
    };
    const input = { policyId: 'policy', idempotencyKey: 'dual-success', name: 'demo.txt', contentType: 'text/plain', size: 3, body: new Blob(['abc']), admin: true };
    const ok = await service.upload(input);
    assert.equal(ok.file.status, 'available');
    assert.ok(usageRecords[0].database_bytes_estimate > 0);
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
    await assert.rejects(() => service.upload({ ...input, idempotencyKey: 'invalid-mode', mode: 'unbounded', body: new Blob(['abc']) }), /Unsupported upload mode/);
  });

  it('accepts at most five multipart files at the route boundary', () => {
    const five = new FormData();
    for (let index = 0; index < 5; index += 1) five.append('file', new File(['x'], `file-${index}.txt`, { type: 'text/plain' }));
    assert.equal(uploadFiles(five).length, 5);
    five.append('file', new File(['x'], 'file-5.txt', { type: 'text/plain' }));
    assert.equal(uploadFiles(five).length, 6);
  });

  it('queues async replicas without adding them to the synchronous write set', async () => {
    const repo = new UploadMemoryRepository();
    repo.policy.async_channels_json = JSON.stringify(['async-channel']);
    repo.channels.set('async-channel', { id: 'async-channel', provider: 'webdav', enabled: 1, health_status: 'healthy' });
    const jobs = { records: [], async create(job) { this.records.push(job); return job; } };
    const guard = { limits: { HARD_MAX_UPLOAD_BYTES: 20 * 1024 * 1024, MAX_UPLOAD_BYTES: 10 * 1024 * 1024, MAX_SYNC_CHANNELS: 2 }, async assertWrite() {}, async assertRepair() {}, async assertAsyncReplica() {}, async record() {} };
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

  it('rejects an unavailable synchronous channel before creating a logical file', async () => {
    const repo = new UploadMemoryRepository();
    repo.channels.set('telegram', { id: 'telegram', enabled: 1, health_status: 'offline' });
    const guard = { limits: { HARD_MAX_UPLOAD_BYTES: 20 * 1024 * 1024, MAX_UPLOAD_BYTES: 10 * 1024 * 1024, MAX_SYNC_CHANNELS: 2 }, async assertWrite() {}, async assertRepair() {}, async assertAsyncReplica() {}, async record() {} };
    const service = new UploadService(repo, guard, { ZERO_COST_MODE: 'true' }, null);

    await assert.rejects(() => service.upload({ policyId: 'policy', idempotencyKey: 'offline-sync', name: 'demo.txt', contentType: 'text/plain', size: 3, body: new Blob(['abc']), admin: true }), /not writable/);
    assert.equal(repo.files.size, 0);
  });

  it('rejects a rate-paused synchronous channel before creating a logical file', async () => {
    const repo = new UploadMemoryRepository();
    repo.channels.set('telegram', { id: 'telegram', enabled: 1, health_status: 'healthy', blocked_until: Date.now() + 60_000 });
    const guard = { limits: { HARD_MAX_UPLOAD_BYTES: 20 * 1024 * 1024, MAX_UPLOAD_BYTES: 10 * 1024 * 1024, MAX_SYNC_CHANNELS: 2 }, async assertWrite() {}, async assertRepair() {}, async assertAsyncReplica() {}, async record() {} };
    const service = new UploadService(repo, guard, { ZERO_COST_MODE: 'true' }, null);
    await assert.rejects(() => service.upload({ policyId: 'policy', idempotencyKey: 'paused-sync', name: 'demo.txt', contentType: 'text/plain', size: 3, body: new Blob(['abc']), admin: true }), /not writable/);
    assert.equal(repo.files.size, 0);
  });

  it('requires an allowed MIME type and matching filename extension', async () => {
    const repo = new UploadMemoryRepository();
    const guard = { limits: { HARD_MAX_UPLOAD_BYTES: 20 * 1024 * 1024, MAX_UPLOAD_BYTES: 10 * 1024 * 1024, MAX_SYNC_CHANNELS: 2 }, async assertWrite() {}, async assertRepair() {}, async assertAsyncReplica() {}, async record() {} };
    const service = new UploadService(repo, guard, { ZERO_COST_MODE: 'true' }, null);
    await assert.rejects(() => service.upload({ policyId: 'policy', idempotencyKey: 'mismatched-type', name: 'unsafe.exe', contentType: 'text/plain', size: 3, body: new Blob(['abc']), admin: true }), error => error.status === 415);
    assert.equal(repo.files.size, 0);
  });

  it('rejects restricted channel capabilities and object-size limits before creating a file', async () => {
    const guard = { limits: { HARD_MAX_UPLOAD_BYTES: 20 * 1024 * 1024, MAX_UPLOAD_BYTES: 10 * 1024 * 1024, MAX_SYNC_CHANNELS: 2 }, async assertWrite() {}, async assertRepair() {}, async assertAsyncReplica() {}, async record() {} };
    const noWrite = new UploadMemoryRepository();
    noWrite.channels.set('telegram', { id: 'telegram', provider: 'telegram', enabled: 1, health_status: 'healthy', capabilities_json: '{"write":false}' });
    await assert.rejects(() => new UploadService(noWrite, guard, {}, null).upload({ policyId: 'policy', idempotencyKey: 'no-write', name: 'demo.txt', contentType: 'text/plain', size: 3, body: new Blob(['abc']), admin: true }), /must support read, write, and delete/);
    assert.equal(noWrite.files.size, 0);

    const sizeLimited = new UploadMemoryRepository();
    sizeLimited.channels.set('telegram', { id: 'telegram', provider: 'telegram', enabled: 1, health_status: 'healthy', capabilities_json: '{"maxObjectSize":2}' });
    await assert.rejects(() => new UploadService(sizeLimited, guard, {}, null).upload({ policyId: 'policy', idempotencyKey: 'size-limit', name: 'demo.txt', contentType: 'text/plain', size: 3, body: new Blob(['abc']), admin: true }), error => error.status === 413);
    assert.equal(sizeLimited.files.size, 0);
  });

  it('does not let an optional async replica make a missing sync backup available', async () => {
    const repository = {
      async getFile() { return { id: 'file_1', status: 'receiving' }; },
      async listReplicas() { return [
        { id: 'primary', role: 'primary', status: 'healthy' },
        { id: 'sync', role: 'sync_backup', status: 'retry_wait' },
        { id: 'async', role: 'async_backup', status: 'healthy' },
      ]; },
      async updateFileStatus(_id, status) { return { status }; },
    };
    const result = await new StorageOrchestrator(repository, {}).recomputeFileHealth('file_1');
    assert.equal(result.status, 'degraded');
  });

  it('uses policy synchronous-copy thresholds for health without hiding the last readable replica', async () => {
    const repository = {
      async getFile() { return { id: 'file_1', policy_id: 'policy_1', status: 'receiving' }; },
      async getPolicy() { return { required_copies: 1, minimum_readable_copies: 1 }; },
      async listReplicas() { return [
        { id: 'primary', role: 'primary', status: 'healthy' },
        { id: 'sync', role: 'sync_backup', status: 'retry_wait' },
      ]; },
      async updateFileStatus(_id, status) { return { status }; },
    };
    assert.equal((await new StorageOrchestrator(repository, {}).recomputeFileHealth('file_1')).status, 'available');
    repository.getPolicy = async () => ({ required_copies: 2, minimum_readable_copies: 1 });
    assert.equal((await new StorageOrchestrator(repository, {}).recomputeFileHealth('file_1')).status, 'degraded');
  });

  it('pauses quota-risk policies before creating a logical file', async () => {
    const repo = new UploadMemoryRepository();
    repo.policy.stop_when_quota_risk = 1;
    const guard = {
      limits: { HARD_MAX_UPLOAD_BYTES: 20 * 1024 * 1024, MAX_UPLOAD_BYTES: 10 * 1024 * 1024, MAX_SYNC_CHANNELS: 2 },
      async assertWrite() {}, async status() { return { level: 'WARNING' }; }, async assertRepair() {}, async assertAsyncReplica() {}, async record() {},
    };
    const service = new UploadService(repo, guard, { ZERO_COST_MODE: 'true' }, null);
    await assert.rejects(() => service.upload({ policyId: 'policy', idempotencyKey: 'quota-risk', name: 'demo.txt', contentType: 'text/plain', size: 3, body: new Blob(['abc']), admin: true }), error => error.code === 'QUOTA_RISK_POLICY' && error.status === 503);
    assert.equal(repo.files.size, 0);
    repo.policy.stop_when_quota_risk = 0;
    service.orchestrator = {
      async writeReplica(file, replica) { await repo.updateReplica(replica.id, { status: 'healthy' }); return { replica: await repo.getReplica(replica.id), stored: { size: file.size } }; },
      async recomputeFileHealth(fileId) { return repo.updateFileStatus(fileId, 'available'); },
    };
    const result = await service.upload({ policyId: 'policy', idempotencyKey: 'quota-risk-opt-out', name: 'demo.txt', contentType: 'text/plain', size: 3, body: new Blob(['abc']), admin: true });
    assert.equal(result.file.status, 'available');
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
    assert.equal(result.response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(await result.response.text(), 'backup');
    assert.equal(repository.replicas[0].status, 'suspect');
    assert.equal(jobs.records[0].operation, 'REPAIR_REPLICA');
    assert.equal(repository.audits[0].action, 'file.readFallback');
    storage.openReplica = async () => { throw new Error('offline'); };
    assert.equal((await service.read('file_1', new Request('https://example.test/file/file_1'))).response.status, 503);
  });

  it('keeps a fallback read side-effect-free when the Zero-Cost Guard is read-only', async () => {
    const repository = new FileMemoryRepository();
    const jobs = { records: [], async create(job) { this.records.push(job); } };
    const health = { successes: 0, failures: 0, async recordSuccess() { this.successes += 1; }, async recordFailure() { this.failures += 1; } };
    const guard = { async assertRepair() { const error = new Error('Replica repair is paused'); error.code = 'ZERO_COST_GUARD'; error.level = 'READ_ONLY'; throw error; } };
    const storage = {
      async readCandidates() { return repository.replicas; },
      async openReplica(replica) { if (replica.id === 'primary') throw Object.assign(new Error('primary unavailable'), { code: 'NETWORK_ERROR' }); return new Response('backup'); },
    };
    const result = await new FileService({ repository, jobs, storage, health, guard }).read('file_1', new Request('https://example.test/file/file_1'));
    assert.equal(result.response.status, 200);
    assert.equal(await result.response.text(), 'backup');
    assert.equal(repository.replicas[0].status, 'healthy');
    assert.equal(jobs.records.length, 0);
    assert.equal(repository.audits.length, 0);
    assert.equal(health.successes, 0);
    assert.equal(health.failures, 0);
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

  it('persists deletion work before using Queue delivery as a wake-up', async () => {
    const repository = new AtomicDeletionRepository();
    const jobs = { records: [], async create(job, options) { this.records.push({ job, options }); } };
    const tombstone = await new FileService({ repository, jobs, storage: {} }).delete('file_1', 'admin');

    assert.equal(tombstone.generation, 2);
    assert.equal(repository.beginCalls.length, 1);
    assert.equal(repository.beginCalls[0].jobs.length, 2);
    assert.equal(jobs.records.length, 2);
    assert.ok(jobs.records.every(item => item.options.essential));
    assert.ok(jobs.records.every(item => item.job.generation === 2));
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

  it('turns a verified missing or corrupt replica into a deferred repair job', async () => {
    for (const failure of [{ code: 'NOT_FOUND', expected: 'missing' }, { code: 'CHECKSUM_MISMATCH', expected: 'corrupt' }]) {
      const target = { id: 'backup', channel_id: 'telegram', status: 'healthy', enabled: 1, health_status: 'healthy', blocked_until: null };
      const source = { id: 'primary', channel_id: 'webdav', status: 'healthy', enabled: 1, health_status: 'healthy', blocked_until: null };
      const records = [];
      const repository = {
        async updateReplica(_id, patch) { Object.assign(target, patch); },
        async listReplicas() { return [source, target]; },
        async getPolicy() { return { auto_repair: 1 }; },
        async audit(entry) { records.push({ type: 'audit', entry }); },
      };
      const app = {
        repository,
        adapterFor: async () => ({ async head() { throw Object.assign(new Error(failure.code), { code: failure.code }); } }),
        storage: { async recomputeFileHealth() { return { status: 'degraded' }; } },
        health: { async recordFailure() {} },
        guard: { async assertRepair() {} },
        jobs: { async create(job) { records.push({ type: 'job', job }); } },
      };
      await executeStorageJob(app, {}, { id: `verify-${failure.code}`, operation: 'VERIFY_REPLICA' }, { id: 'file_1', policy_id: 'policy', size: 3, generation: 1 }, target);
      assert.equal(target.status, failure.expected);
      assert.equal(records.find(record => record.type === 'job').job.operation, 'REPAIR_REPLICA');
      assert.ok(records.some(record => record.type === 'audit' && record.entry.action === 'replica.verificationFailed'));
    }
  });

  it('does not read a repair source when the destination channel is unavailable', async () => {
    const source = { id: 'primary', channel_id: 'webdav', status: 'healthy', enabled: 1, health_status: 'healthy', blocked_until: null };
    const target = { id: 'backup', channel_id: 'telegram', status: 'missing', enabled: 1, health_status: 'offline', blocked_until: null };
    let sourceOpened = false;
    const app = {
      repository: {
        async listReplicas() { return [source, target]; },
        async getChannel() { return { id: 'telegram', enabled: 1, health_status: 'offline' }; },
      },
      storage: { async openReplica() { sourceOpened = true; return new Response('abc'); } },
    };
    await assert.rejects(() => executeStorageJob(app, {}, { operation: 'REPAIR_REPLICA', idempotency_key: 'repair' }, { id: 'file_1', size: 3, generation: 1 }, target), error => error.code === 'CHANNEL_UNAVAILABLE');
    assert.equal(sourceOpened, false);
  });

  it('does not retry deletion work while the zero-cost guard is in emergency mode', async () => {
    const repository = {
      async getJob() { return { id: 'job_1', status: 'dead', operation: 'DELETE_REPLICA', file_id: 'file_1', replica_id: 'rep_1' }; },
    };
    const guard = {
      async assertDelete() { const error = new Error('Deletion is paused'); error.code = 'ZERO_COST_GUARD'; error.level = 'EMERGENCY'; throw error; },
    };
    await assert.rejects(() => new JobService(repository, guard).retry('job_1'), error => error.code === 'ZERO_COST_GUARD' && error.level === 'EMERGENCY');
  });

  it('does not retry file health recount work while writes are limited', async () => {
    const repository = {
      updates: 0,
      async getJob() { return { id: 'job_1', status: 'dead', operation: 'RECOUNT_FILE_HEALTH', file_id: 'file_1', replica_id: null }; },
      async updateJob() { this.updates += 1; },
    };
    const guard = {
      async assertWrite() { const error = new Error('Writes are paused'); error.code = 'ZERO_COST_GUARD'; error.level = 'WRITE_LIMITED'; throw error; },
    };
    await assert.rejects(() => new JobService(repository, guard).retry('job_1'), error => error.code === 'ZERO_COST_GUARD' && error.level === 'WRITE_LIMITED');
    assert.equal(repository.updates, 0);
  });
});

describe('zero-cost controls and security', () => {
  it('rotates bounded maintenance health checks across every channel', async () => {
    const channels = Array.from({ length: 7 }, (_, index) => ({ id: `channel_${index + 1}`, cursor: index + 1 }));
    const repository = {
      cursor: 0,
      async getMaintenanceCursor() { return this.cursor; },
      async listChannelsAfter(cursor, limit) { return channels.filter(channel => channel.cursor > cursor).slice(0, limit); },
      async setMaintenanceCursor(_name, cursor) { this.cursor = cursor; },
    };
    const first = await selectRotatingHealthCheckChannels(repository, 5);
    const second = await selectRotatingHealthCheckChannels(repository, 5);
    const third = await selectRotatingHealthCheckChannels(repository, 5);
    assert.deepEqual(first.map(channel => channel.id), ['channel_1', 'channel_2', 'channel_3', 'channel_4', 'channel_5']);
    assert.deepEqual(second.map(channel => channel.id), ['channel_6', 'channel_7']);
    assert.deepEqual(third.map(channel => channel.id), ['channel_1', 'channel_2', 'channel_3', 'channel_4', 'channel_5']);
  });
  it('rotates bounded replica maintenance and schedules idempotent low-cost work', async () => {
    const replicas = Array.from({ length: 7 }, (_, index) => ({ id: `replica_${index + 1}`, file_id: `file_${index + 1}`, channel_id: 'webdav', file_generation: 1, cursor: index + 1, status: index < 5 ? 'healthy' : 'missing', role: 'primary' }));
    const repository = {
      cursor: 0,
      async getMaintenanceCursor() { return this.cursor; },
      async listReplicaMaintenanceAfter(cursor, limit) { return replicas.filter(replica => replica.cursor > cursor).slice(0, limit); },
      async setMaintenanceCursor(_name, cursor) { this.cursor = cursor; },
    };
    const first = await selectRotatingReplicaMaintenance(repository, 5);
    const second = await selectRotatingReplicaMaintenance(repository, 5);
    assert.deepEqual(first.map(replica => replica.id), ['replica_1', 'replica_2', 'replica_3', 'replica_4', 'replica_5']);
    assert.deepEqual(second.map(replica => replica.id), ['replica_6', 'replica_7']);
    const jobs = [];
    const scheduled = await scheduleReplicaMaintenance({ jobs: { async create(job) { jobs.push(job); } } }, [first[0], second[0]], { V3_REPLICA_VERIFY_INTERVAL_MS: '3600000', V3_REPLICA_REPAIR_INTERVAL_MS: '900000' });
    assert.equal(scheduled, 2);
    assert.equal(jobs[0].operation, 'VERIFY_REPLICA');
    assert.equal(jobs[1].operation, 'REPAIR_REPLICA');
    assert.match(jobs[0].idempotencyKey, /^maintenance:VERIFY_REPLICA:/);
  });
  it('schedules only bounded essential repairs while writes are limited', async () => {
    const replicas = Array.from({ length: 6 }, (_, index) => ({ id: `replica_${index + 1}`, file_id: `file_${index + 1}`, channel_id: 'telegram', file_generation: 1, cursor: index + 1, status: 'missing', role: 'sync_backup' }));
    const repository = {
      cursor: 0,
      async getMaintenanceCursor() { return this.cursor; },
      async listCriticalReplicaMaintenanceAfter(cursor, limit) { return replicas.filter(replica => replica.cursor > cursor).slice(0, limit); },
      async setMaintenanceCursor(_name, cursor) { this.cursor = cursor; },
    };
    const first = await selectRotatingCriticalReplicaMaintenance(repository, 5);
    const second = await selectRotatingCriticalReplicaMaintenance(repository, 5);
    assert.deepEqual(first.map(replica => replica.id), ['replica_1', 'replica_2', 'replica_3', 'replica_4', 'replica_5']);
    assert.deepEqual(second.map(replica => replica.id), ['replica_6']);
    const calls = [];
    await scheduleReplicaMaintenance({ jobs: { async create(job, options) { calls.push({ job, options }); } } }, first.slice(0, 1), {}, { essentialRepair: true });
    assert.equal(calls[0].job.operation, 'REPAIR_REPLICA');
    assert.equal(calls[0].options.essential, true);
  });
  it('returns client errors for malformed management JSON and guard-limited mutations', async () => {
    const malformedChannel = await patchChannel({ request: new Request('https://example.test/api/manage/ops/channels', { method: 'PATCH', body: '{' }), env: {} });
    const malformedPolicy = await createPolicy({ request: new Request('https://example.test/api/manage/ops/policies', { method: 'POST', body: '{' }), env: {} });
    assert.equal(malformedChannel.status, 400);
    assert.equal(malformedPolicy.status, 400);

    const env = { DB: readOnlyD1() };
    const channelRequest = new Request('https://example.test/api/manage/ops/channels', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelId: 'channel_1', action: 'health_check' }) });
    const policyRequest = new Request('https://example.test/api/manage/ops/policies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    const channel = await patchChannel({ request: channelRequest, env });
    const policy = await createPolicy({ request: policyRequest, env });
    assert.equal(channel.status, 503);
    assert.equal(policy.status, 503);
    assert.equal((await channel.json()).code, 'ZERO_COST_GUARD');
    assert.equal((await policy.json()).code, 'ZERO_COST_GUARD');
  });
  it('enforces read-only writes while leaving reads outside the guard', async () => {
    const repository = { async getUsage() { return { uploads: 500 }; }, async incrementUsage() {}, async setProtectionLevel() {} };
    const guard = new ZeroCostGuard(repository, { DAILY_UPLOAD_SOFT_LIMIT: '500' });
    await assert.rejects(() => guard.assertWrite({ admin: true }), error => error.level === 'READ_ONLY');
  });
  it('rejects private endpoints without an override', () => {
    assert.throws(() => assertExternalEndpoint('http://storage.example/dav'));
    assert.throws(() => assertExternalEndpoint('http://127.0.0.1/dav'));
    assert.throws(() => assertExternalEndpoint('http://127.0.0.1/dav', { allowPrivate: true }));
    assert.throws(() => assertExternalEndpoint('http://100.64.0.1/dav'));
    assert.throws(() => assertExternalEndpoint('http://[::ffff:127.0.0.1]/dav'));
    assert.equal(assertExternalEndpoint('https://storage.example/dav').hostname, 'storage.example');
  });
  it('rejects storage policies that select a channel without the required contract', async () => {
    const channels = new Map([
      ['webdav', { id: 'webdav', provider: 'webdav', failure_domain: 'nas-a' }],
      ['telegram', { id: 'telegram', provider: 'telegram', failure_domain: 'telegram', capabilities_json: '{"delete":false}' }],
    ]);
    const repository = { async getChannel(id) { return channels.get(id) || null; } };
    const result = await validatePolicy(repository, { name: 'safe', primaryChannelId: 'webdav', syncBackupChannelId: 'telegram', writeMode: 'safe', requiredCopies: 2, minimumReadableCopies: 1 });
    assert.equal(result, 'Every policy channel must support read, write, and delete operations');
  });
  it('flags active R2 bindings in deployment configuration', () => {
    const base = process.cwd();
    assert.deepEqual(inspectZeroCostFiles(base), []);
  });
  it('fails the zero-cost scan when a disposable Wrangler config declares R2', () => {
    const base = mkdtempSync(join(tmpdir(), 'imgbed-zero-cost-r2-'));
    try {
      for (const dir of ['deploy/worker', '.github/workflows', 'functions/core/storage']) mkdirSync(join(base, dir), { recursive: true });
      writeFileSync(join(base, 'deploy/worker/wrangler.toml'), '[vars]\nZERO_COST_MODE = "true"\nALLOW_R2 = "false"\n[[r2_buckets]]\nbinding = "R2"\nbucket_name = "forbidden"\n');
      writeFileSync(join(base, 'deploy/worker/generate-toml.js'), '');
      writeFileSync(join(base, '.github/workflows/deploy-worker.yml'), '');
      writeFileSync(join(base, 'wrangler.toml.example'), '');
      writeFileSync(join(base, 'functions/core/storage/registry.js'), "if (provider === 'r2' && !r2Allowed) throw new Error('disabled');");
      writeFileSync(join(base, 'deploy/worker/index.js'), "function zeroCostEnvironment(property) { return property === 'img_r2'; }");
      assert.ok(inspectZeroCostFiles(base).some(message => message.includes('R2 binding')));
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
  it('scans the checked-in deployment Worker template for forbidden bindings', () => {
    const base = mkdtempSync(join(tmpdir(), 'imgbed-zero-cost-template-'));
    try {
      for (const dir of ['deploy/worker', '.github/workflows', 'functions/core/storage', 'functions/adapters/s3', 'functions/adapters/webdav', 'functions/adapters/telegram', 'functions/api/manage/ops']) mkdirSync(join(base, dir), { recursive: true });
      writeFileSync(join(base, 'deploy/worker/wrangler.toml'), '[vars]\nZERO_COST_MODE = "true"\nALLOW_R2 = "false"\n');
      writeFileSync(join(base, 'wrangler.toml.example'), '[vars]\nZERO_COST_MODE = "true"\nALLOW_R2 = "false"\n');
      writeFileSync(join(base, 'deploy/worker/wrangler.toml.example'), '[vars]\nZERO_COST_MODE = "true"\nALLOW_R2 = "false"\n[[r2_buckets]]\nbinding = "R2"\nbucket_name = "forbidden"\n[[kv_namespaces]]\nbinding = "KV"\nid = "forbidden"\n');
      writeFileSync(join(base, 'deploy/worker/generate-toml.js'), '');
      writeFileSync(join(base, '.github/workflows/deploy-worker.yml'), '');
      writeFileSync(join(base, 'functions/core/storage/registry.js'), "if (provider === 'r2' && !r2Allowed) throw new Error('disabled');");
      writeFileSync(join(base, 'deploy/worker/index.js'), "function zeroCostEnvironment(property) { return property === 'img_r2'; }");
      for (const file of ['functions/core/storage/orchestrator.js', 'functions/adapters/webdav/webdavAdapter.js', 'functions/adapters/telegram/telegramAdapter.js', 'functions/adapters/s3/s3Adapter.js', 'functions/api/manage/ops/channels.js']) writeFileSync(join(base, file), '');
      const failures = inspectZeroCostFiles(base);
      assert.ok(failures.some(message => message.includes('Deployment Worker template declares an R2 binding')));
      assert.ok(failures.some(message => message.includes('Forbidden paid Cloudflare resource in deploy/worker/wrangler.toml.example')));
      assert.ok(failures.some(message => message.includes('kv_namespaces')));
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('fails the zero-cost scan when the local start command declares KV', () => {
    const base = mkdtempSync(join(tmpdir(), 'zero-cost-package-'));
    try {
      mkdirSync(join(base, 'deploy/worker'), { recursive: true });
      mkdirSync(join(base, 'functions/core/storage'), { recursive: true });
      mkdirSync(join(base, 'functions/adapters/webdav'), { recursive: true });
      mkdirSync(join(base, 'functions/adapters/telegram'), { recursive: true });
      mkdirSync(join(base, 'functions/adapters/s3'), { recursive: true });
      mkdirSync(join(base, 'functions/api/manage/ops'), { recursive: true });
      writeFileSync(join(base, 'deploy/worker/wrangler.toml'), '[vars]\nZERO_COST_MODE = "true"\nALLOW_R2 = "false"\n');
      writeFileSync(join(base, 'wrangler.toml.example'), '[vars]\nZERO_COST_MODE = "true"\nALLOW_R2 = "false"\n');
      writeFileSync(join(base, 'deploy/worker/wrangler.toml.example'), '[vars]\nZERO_COST_MODE = "true"\nALLOW_R2 = "false"\n');
      writeFileSync(join(base, 'deploy/worker/index.js'), "function zeroCostEnvironment(property) { return property === 'img_r2'; }");
      writeFileSync(join(base, 'functions/core/storage/registry.js'), "if (channel.provider === 'r2' && !r2Allowed(env)) {}");
      for (const file of ['functions/core/storage/orchestrator.js', 'functions/adapters/webdav/webdavAdapter.js', 'functions/adapters/telegram/telegramAdapter.js', 'functions/adapters/s3/s3Adapter.js', 'functions/api/manage/ops/channels.js']) writeFileSync(join(base, file), 'export {};');
      writeFileSync(join(base, 'package.json'), '{"scripts":{"start":"wrangler pages dev --kv img_url"}}');
      assert.ok(inspectZeroCostFiles(base).some(message => message.includes('Local start script')));
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
  it('starts the local zero-cost Worker through the project Wrangler entrypoint', () => {
    const startup = readFileSync('scripts/start-zero-cost-worker.mjs', 'utf8');
    assert.match(startup, /node_modules\/wrangler\/bin\/wrangler\.js/);
    assert.match(startup, /spawn\(process\.execPath/);
    assert.doesNotMatch(startup, /npx(?:\.cmd)?/);
  });
  it('fails the zero-cost scan when V3 source accesses an R2 binding', () => {
    const base = mkdtempSync(join(tmpdir(), 'imgbed-zero-cost-v3-r2-'));
    try {
      for (const dir of ['deploy/worker', '.github/workflows', 'functions/core/storage', 'functions/adapters/s3']) mkdirSync(join(base, dir), { recursive: true });
      writeFileSync(join(base, 'deploy/worker/wrangler.toml'), '[vars]\nZERO_COST_MODE = "true"\nALLOW_R2 = "false"\n');
      writeFileSync(join(base, 'deploy/worker/generate-toml.js'), '');
      writeFileSync(join(base, '.github/workflows/deploy-worker.yml'), '');
      writeFileSync(join(base, 'wrangler.toml.example'), '');
      writeFileSync(join(base, 'functions/core/storage/registry.js'), "if (provider === 'r2' && !r2Allowed) throw new Error('disabled');");
      writeFileSync(join(base, 'deploy/worker/index.js'), "function zeroCostEnvironment(property) { return property === 'img_r2'; }");
      writeFileSync(join(base, 'functions/adapters/s3/s3Adapter.js'), 'export const forbidden = env.R2;');
      assert.ok(inspectZeroCostFiles(base).some(message => message.includes('forbidden R2 binding')));
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
  it('requires real V3 bindings for a deployment configuration', () => {
    const path = 'deploy/worker/wrangler.toml';
    const original = readFileSync(path, 'utf8');
    try {
      assert.throws(() => execFileSync(process.execPath, ['deploy/worker/generate-toml.js', '--require-bindings'], { cwd: process.cwd(), stdio: 'pipe' }), /D1_DATABASE_ID and STORAGE_QUEUE_NAME/);
      const result = execFileSync(process.execPath, ['deploy/worker/generate-toml.js', '--require-bindings'], {
        cwd: process.cwd(), stdio: 'pipe', env: { ...process.env, D1_DATABASE_ID: '00000000-0000-0000-0000-000000000001', STORAGE_QUEUE_NAME: 'imgbed-storage-zero-cost' },
      }).toString();
      assert.match(result, /\[\[d1_databases\]\]/);
      assert.match(readFileSync(path, 'utf8'), /binding = "STORAGE_QUEUE"/);
      assert.doesNotMatch(readFileSync(path, 'utf8'), /\[\[kv_namespaces\]\]/);
      assert.match(execFileSync(process.execPath, ['scripts/validate-worker-deployment.mjs'], { cwd: process.cwd(), stdio: 'pipe' }).toString(), /DB and STORAGE_QUEUE/);
      assert.throws(() => execFileSync(process.execPath, ['deploy/worker/generate-toml.js', '--require-bindings'], {
        cwd: process.cwd(), stdio: 'pipe', env: { ...process.env, D1_DATABASE_ID: '00000000-0000-0000-0000-000000000001', STORAGE_QUEUE_NAME: 'imgbed-storage-zero-cost', KV_NAMESPACE_ID: 'forbidden-kv-binding' },
      }), /forbidden Cloudflare resource setting/);
      assert.throws(() => execFileSync(process.execPath, ['deploy/worker/generate-toml.js', '--require-bindings'], {
        cwd: process.cwd(), stdio: 'pipe', env: { ...process.env, D1_DATABASE_ID: '00000000-0000-0000-0000-000000000001', STORAGE_QUEUE_NAME: 'imgbed-storage-zero-cost', WORKER_VARS: '{"KV_NAMESPACE_ID":"forbidden-kv-binding"}' },
      }), /WORKER_VARS contains forbidden key KV_NAMESPACE_ID/);
    } finally {
      writeFileSync(path, original, 'utf8');
    }
  });
  it('requires storage credentials to be supplied as secret references', () => {
    assert.equal(hasSensitiveConfig({ baseUrl: 'https://storage.example/dav' }), false);
    assert.equal(hasSensitiveConfig({ password: 'not-allowed' }), true);
    assert.equal(hasSensitiveConfig({ botToken: 'not-allowed' }), true);
    assert.equal(hasSensitiveConfig({ accessKeyId: 'not-allowed' }), true);
  });
  it('rejects redirecting and plaintext-credential adapter configuration', async () => {
    const redirecting = new WebDavAdapter({ id: 'webdav', config: { baseUrl: 'https://storage.example/dav' } }, {}, async () => new Response(null, { status: 302 }));
    await assert.rejects(() => redirecting.head({ objectKey: 'a.txt' }), error => error.code === STORAGE_ERROR_CODES.INVALID_CONFIGURATION);
    let plaintextHeaders;
    const plaintext = new WebDavAdapter({ id: 'webdav', config: { baseUrl: 'https://storage.example/dav', username: 'unsafe', password: 'unsafe' } }, {}, async (_url, init) => { plaintextHeaders = new Headers(init.headers); return new Response(null, { status: 200 }); });
    await plaintext.healthCheck();
    assert.equal(plaintextHeaders.has('Authorization'), false);
    assert.equal(hasSensitiveConfig({ headers: { Authorization: 'Basic secret' } }), true);
  });
  it('moves a channel through degraded, offline, rate-limited, and recovered health', async () => {
    const channel = { id: 'channel_1', health_status: 'unknown', consecutive_failures: 0, consecutive_successes: 0 };
    const updates = [];
    const repository = { async setChannelHealth(_id, status, patch) { updates.push({ status, patch }); Object.assign(channel, { health_status: status, consecutive_failures: patch.consecutiveFailures, consecutive_successes: patch.consecutiveSuccesses }); return channel; }, async getChannel() { return channel; } };
    const health = new ChannelHealthService(repository, {});
    await health.recordFailure(channel, Object.assign(new Error('network'), { code: 'NETWORK_ERROR' }));
    await health.recordFailure(channel, Object.assign(new Error('network'), { code: 'NETWORK_ERROR' }));
    await health.recordFailure(channel, Object.assign(new Error('network'), { code: 'NETWORK_ERROR' }));
    assert.equal(updates.at(-1).status, 'degraded');
    await health.recordFailure(channel, Object.assign(new Error('rate'), { code: 'RATE_LIMITED', retryAfterSeconds: 10 }));
    assert.ok(updates.at(-1).patch.blockedUntil > Date.now());
    await health.recordFailure(channel, Object.assign(new Error('auth'), { code: 'AUTH_FAILED' }));
    assert.equal(updates.at(-1).status, 'offline');
    await health.recordSuccess(channel); await health.recordSuccess(channel);
    assert.equal(updates.at(-1).status, 'healthy');
  });
});

class UploadMemoryRepository {
  constructor() { this.files = new Map(); this.replicas = new Map(); this.channels = new Map([['webdav', { id: 'webdav', provider: 'webdav', enabled: 1, health_status: 'healthy' }], ['telegram', { id: 'telegram', provider: 'telegram', enabled: 1, health_status: 'healthy' }]]); this.policy = { id: 'policy', enabled: 1, primary_channel_id: 'webdav', sync_backup_channel_id: 'telegram', write_mode: 'safe' }; }
  async getFileByIdempotency(key) { return [...this.files.values()].find(file => file.idempotency_key === key) || null; }
  async getPolicy() { return this.policy; }
  async createFileWithReplicas(file, specs) { const row = { ...file, idempotency_key: file.idempotencyKey, generation: 1 }; this.files.set(row.id, row); specs.forEach(spec => this.replicas.set(spec.id, { id: spec.id, file_id: row.id, channel_id: spec.channelId, role: spec.role, object_key: spec.objectKey, status: 'planned' })); return row; }
  async listReplicas(fileId) { return [...this.replicas.values()].filter(item => item.file_id === fileId); }
  async getReplica(id) { return this.replicas.get(id); }
  async getChannel(id) { return { config_json: '{}', secret_refs_json: '{}', ...this.channels.get(id) }; }
  async updateReplica(id, patch) { const replica = this.replicas.get(id); Object.assign(replica, patch); return replica; }
  async updateFileStatus(id, status) { const file = this.files.get(id); file.status = status; return file; }
}

class FileMemoryRepository {
  constructor() {
    this.file = { id: 'file_1', generation: 1, status: 'available', name: 'demo.html', content_type: 'text/html', is_public: 1, size: 6 };
    this.replicas = [{ id: 'primary', channel_id: 'webdav', status: 'healthy', role: 'primary', enabled: 1, health_status: 'healthy' }, { id: 'backup', channel_id: 'telegram', status: 'healthy', role: 'sync_backup', enabled: 1, health_status: 'healthy' }];
    this.tombstone = null;
    this.audits = [];
  }
  async getFile() { return this.file; }
  async getTombstone() { return this.tombstone; }
  async listReplicas() { return this.replicas; }
  async updateReplica(id, patch) { Object.assign(this.replicas.find(item => item.id === id), patch); }
  async createTombstone(_id, generation) { this.file.status = 'deleting'; this.file.generation = generation + 1; this.tombstone = { generation: this.file.generation }; return this.tombstone; }
  async finalizeDeletion() { if (this.replicas.every(item => item.status === 'deleted')) this.file.status = 'deleted'; return this.file; }
  async audit(entry) { this.audits.push(entry); }
}

class AtomicDeletionRepository extends FileMemoryRepository {
  constructor() { super(); this.beginCalls = []; }
  async beginDeletion(input) {
    this.beginCalls.push(input);
    this.file.status = 'deleting';
    this.file.generation = input.expectedGeneration + 1;
    this.tombstone = { generation: this.file.generation };
    return this.tombstone;
  }
}

function readOnlyD1() {
  return {
    prepare() {
      return {
        bind() { return this; },
        async first() { return { uploads: 500, protection_level: 'NORMAL' }; },
      };
    },
  };
}
