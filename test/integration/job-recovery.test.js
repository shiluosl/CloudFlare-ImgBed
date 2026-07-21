import assert from 'node:assert/strict';
import { JobService } from '../../functions/core/jobs/jobService.js';
import { consumeStorageJobs } from '../../functions/queues/storageConsumer.js';

describe('D1 job and Queue recovery integration', () => {
  it('keeps a D1 job pending when Queue delivery fails, then cron redispatches it', async () => {
    const repository = new JobRepository();
    const queue = new FlakyQueue();
    const jobs = new JobService(repository, permissiveGuard(), queue);
    const created = await jobs.create(jobInput('job_queue_failure'));
    assert.equal(created.status, 'pending');
    assert.equal(queue.messages.length, 0);

    const recovery = await jobs.redispatchDue();
    assert.equal(recovery.dispatched, 1);
    assert.equal(queue.messages.length, 1);
    assert.equal((await repository.getJob(created.id)).status, 'queued');
  });

  it('recovers an expired consumer lease and redispatches the durable job once', async () => {
    const repository = new JobRepository();
    const expired = await repository.createJob({ ...jobInput('job_expired_lease'), status: 'running' });
    expired.lease_until = Date.now() - 1;
    const queue = new FlakyQueue(false);
    const jobs = new JobService(repository, permissiveGuard(), queue);

    const recovery = await jobs.redispatchDue();
    assert.equal(recovery.recovered, 1);
    assert.equal(recovery.dispatched, 1);
    assert.equal((await repository.getJob(expired.id)).status, 'queued');
    assert.equal(queue.messages[0].jobId, expired.id);
  });

  it('in read-only mode recovers and redispatches deletion leases only', async () => {
    const repository = new ProtectedRecoveryRepository([
      expiredJob('job_ordinary_read_only', 'RECOUNT_FILE_HEALTH'),
      expiredJob('job_delete_read_only', 'DELETE_REPLICA'),
    ]);
    const queue = new FlakyQueue(false);
    const jobs = new JobService(repository, permissiveGuard(), queue);

    const recovery = await jobs.redispatchDue(50, { level: 'READ_ONLY' });

    assert.equal(recovery.recovered, 1);
    assert.equal(recovery.dispatched, 1);
    assert.equal((await repository.getJob('job_ordinary_read_only')).status, 'running');
    assert.equal((await repository.getJob('job_delete_read_only')).status, 'queued');
    assert.deepEqual(queue.messages.map(message => message.jobId), ['job_delete_read_only']);
  });

  it('in write-limited mode redispatches deletion and last-copy repair leases only', async () => {
    const repository = new ProtectedRecoveryRepository([
      expiredJob('job_ordinary_limited', 'RECONCILE_FILE'),
      expiredJob('job_repair_limited', 'REPAIR_REPLICA', 'replica_target'),
      expiredJob('job_delete_limited', 'DELETE_REPLICA'),
    ]);
    const queue = new FlakyQueue(false);
    const jobs = new JobService(repository, permissiveGuard(), queue);

    const recovery = await jobs.redispatchDue(50, { level: 'WRITE_LIMITED' });

    assert.equal(recovery.recovered, 2);
    assert.equal(recovery.dispatched, 2);
    assert.equal((await repository.getJob('job_ordinary_limited')).status, 'running');
    assert.equal((await repository.getJob('job_repair_limited')).status, 'queued');
    assert.equal((await repository.getJob('job_delete_limited')).status, 'queued');
    assert.deepEqual(queue.messages.map(message => message.jobId).sort(), ['job_delete_limited', 'job_repair_limited']);
  });

  it('does not recover or redispatch any lease in emergency mode', async () => {
    const repository = new ProtectedRecoveryRepository([expiredJob('job_emergency', 'DELETE_REPLICA')]);
    const queue = new FlakyQueue(false);
    const jobs = new JobService(repository, permissiveGuard(), queue);

    const recovery = await jobs.redispatchDue(50, { level: 'EMERGENCY' });

    assert.deepEqual(recovery, { dispatched: 0, recovered: 0, protectionLevel: 'EMERGENCY' });
    assert.equal((await repository.getJob('job_emergency')).status, 'running');
    assert.equal(queue.messages.length, 0);
    assert.equal(repository.listCalls, 0);
  });

  it('acknowledges duplicate Queue delivery after exactly one D1 claim', async () => {
    const repository = new ConsumerRepository();
    const app = consumerApp(repository);
    const messages = [queueMessage('job_duplicate'), queueMessage('job_duplicate')];

    await consumeStorageJobs({ messages }, {}, () => app);

    assert.equal(repository.claims, 2);
    assert.equal(repository.job.status, 'succeeded');
    assert.equal(app.storage.recounts, 1);
    assert.equal(messages[0].acks, 1);
    assert.equal(messages[1].acks, 1);
  });

  it('retries a remote-success/D1-acknowledgement interruption without falsely marking the replica healthy', async () => {
    const repository = new UncertainWriteRepository();
    let writes = 0;
    const app = uncertainWriteApp(repository, async () => {
      writes += 1;
      return { remoteId: `remote_${writes}`, safeMetadata: {}, size: 3 };
    });

    const first = queueMessage('job_uncertain_write');
    await consumeStorageJobs({ messages: [first] }, {}, () => app);
    assert.equal(writes, 1);
    assert.equal(repository.target.status, 'uploading');
    assert.equal(repository.job.status, 'retry_wait');
    assert.equal(first.retries, 1);

    repository.failAcknowledgement = false;
    const second = queueMessage('job_uncertain_write');
    await consumeStorageJobs({ messages: [second] }, {}, () => app);
    assert.equal(writes, 2);
    assert.equal(repository.target.status, 'healthy');
    assert.equal(repository.job.status, 'succeeded');
    assert.equal(second.acks, 1);
  });

  it('acknowledges read-only recount delivery before claim without changing the durable job', async () => {
    const repository = new ConsumerRepository();
    const app = consumerApp(repository);
    app.guard.assertWrite = async () => {
      const error = new Error('Writes are paused');
      error.code = 'ZERO_COST_GUARD';
      error.level = 'READ_ONLY';
      throw error;
    };
    const message = queueMessage('job_duplicate');

    await consumeStorageJobs({ messages: [message] }, {}, () => app);

    assert.equal(repository.claims, 0);
    assert.equal(repository.job.status, 'queued');
    assert.equal(repository.job.attempts, 0);
    assert.equal(app.storage.recounts, 0);
    assert.equal(message.acks, 1);
  });

  it('does not claim or call an adapter for emergency-paused deletion delivery', async () => {
    const repository = new DeletionRecoveryRepository();
    let adapterCalls = 0;
    const app = deletionApp(repository, async () => { adapterCalls += 1; }, {
      async assertDelete() {
        const error = new Error('Deletion is paused');
        error.code = 'ZERO_COST_GUARD';
        error.level = 'EMERGENCY';
        throw error;
      },
    });
    const message = queueMessage('job_delete_recovery');

    await consumeStorageJobs({ messages: [message] }, {}, () => app);

    assert.equal(repository.claims, 0);
    assert.equal(repository.job.status, 'queued');
    assert.equal(repository.job.attempts, 0);
    assert.equal(adapterCalls, 0);
    assert.equal(message.acks, 1);
  });

  it('allows tombstoned deletion to claim and execute in read-only mode', async () => {
    const repository = new DeletionRecoveryRepository();
    let deleteCalls = 0;
    const app = deletionApp(repository, async () => { deleteCalls += 1; return { deleted: true }; }, {
      async assertDelete() { return 'READ_ONLY'; },
      async assertWrite() { throw new Error('ordinary writes must not run'); },
    });
    const message = queueMessage('job_delete_recovery');

    await consumeStorageJobs({ messages: [message] }, {}, () => app);

    assert.equal(repository.claims, 1);
    assert.equal(deleteCalls, 1);
    assert.equal(repository.file.status, 'deleted');
    assert.equal(repository.job.status, 'succeeded');
  });

  it('cancels late create and repair work when a tombstone advances the generation', async () => {
    const repository = new ConsumerRepository({
      job: { ...jobInput('job_late_repair'), operation: 'REPAIR_REPLICA', replica_id: 'replica_1', generation: 1 },
      file: { id: 'file_1', generation: 2, status: 'deleting' },
      tombstone: { file_id: 'file_1', generation: 2 },
    });
    const message = queueMessage('job_late_repair');

    await consumeStorageJobs({ messages: [message] }, {}, () => consumerApp(repository));

    assert.equal(repository.job.status, 'cancelled');
    assert.equal(message.acks, 1);
  });

  it('marks exhausted deletion as delete_degraded and later completes the same tombstoned deletion', async () => {
    const repository = new DeletionRecoveryRepository();
    const failingMessage = queueMessage('job_delete_recovery');
    const failingApp = deletionApp(repository, async () => { throw Object.assign(new Error('remote offline'), { code: 'NETWORK_ERROR' }); });
    await consumeStorageJobs({ messages: [failingMessage] }, {}, () => failingApp);
    assert.equal(repository.job.status, 'dead');
    assert.equal(repository.file.status, 'delete_degraded');
    assert.equal(failingMessage.acks, 1);

    repository.job.status = 'queued';
    repository.job.attempts = 0;
    const recoveryMessage = queueMessage('job_delete_recovery');
    const recoveryApp = deletionApp(repository, async () => ({ deleted: true }));
    await consumeStorageJobs({ messages: [recoveryMessage] }, {}, () => recoveryApp);
    assert.equal(repository.replica.status, 'deleted');
    assert.equal(repository.file.status, 'deleted');
    assert.equal(repository.job.status, 'succeeded');
  });
});

function jobInput(id) {
  return {
    id,
    fileId: 'file_1',
    replicaId: null,
    channelId: null,
    operation: 'RECOUNT_FILE_HEALTH',
    generation: 1,
    idempotencyKey: `idempotency:${id}`,
    maxAttempts: 3,
    runAfter: Date.now() - 1,
  };
}

function permissiveGuard() {
  return {
    async assertQueue() {},
    async record() {},
  };
}

class FlakyQueue {
  constructor(failFirst = true) { this.failFirst = failFirst; this.messages = []; }
  async send(message) {
    if (this.failFirst) {
      this.failFirst = false;
      throw new Error('Queue temporarily unavailable');
    }
    this.messages.push(message);
  }
}

class JobRepository {
  constructor() { this.jobs = new Map(); }
  async createJob(input) {
    const existing = [...this.jobs.values()].find(job => job.idempotency_key === input.idempotencyKey);
    if (existing) return existing;
    const job = {
      id: input.id,
      file_id: input.fileId,
      replica_id: input.replicaId,
      channel_id: input.channelId,
      operation: input.operation,
      generation: input.generation,
      status: input.status || 'pending',
      attempts: 0,
      max_attempts: input.maxAttempts || 5,
      run_after: input.runAfter || Date.now(),
      idempotency_key: input.idempotencyKey,
      lease_until: null,
    };
    this.jobs.set(job.id, job);
    return job;
  }
  async getJob(id) { return this.jobs.get(id) || null; }
  async updateJob(id, status, patch = {}) {
    const job = this.jobs.get(id);
    job.status = status;
    job.run_after = patch.runAfter ?? Date.now();
    job.lease_until = patch.leaseUntil ?? null;
    return job;
  }
  async dueJobs() { return [...this.jobs.values()].filter(job => ['pending', 'retry_wait', 'queued'].includes(job.status) && job.run_after <= Date.now()); }
  async recoverExpiredLeases() {
    const expired = [...this.jobs.values()].filter(job => job.status === 'running' && job.lease_until <= Date.now());
    for (const job of expired) {
      job.status = 'retry_wait';
      job.lease_until = null;
      job.run_after = Date.now() - 1;
    }
    return expired.length;
  }
}

class ProtectedRecoveryRepository extends JobRepository {
  constructor(jobs) {
    super();
    this.listCalls = 0;
    for (const job of jobs) this.jobs.set(job.id, job);
  }
  async listExpiredLeases() {
    this.listCalls += 1;
    return [...this.jobs.values()].filter(job => job.status === 'running' && job.lease_until <= Date.now());
  }
  async recoverExpiredLeasesByIds(ids) {
    for (const id of ids) {
      const job = this.jobs.get(id);
      if (job?.status === 'running') {
        job.status = 'retry_wait';
        job.lease_until = null;
        job.run_after = Date.now() - 1;
      }
    }
    return ids.length;
  }
  async getReplica(id) {
    return id === 'replica_target' ? { id, role: 'sync_backup', status: 'missing', enabled: 1, health_status: 'healthy', blocked_until: null } : null;
  }
  async getFile() { return { id: 'file_1', status: 'degraded' }; }
  async listReplicas() {
    return [
      { id: 'replica_source', role: 'primary', status: 'healthy', enabled: 1, health_status: 'healthy', blocked_until: null },
      { id: 'replica_target', role: 'sync_backup', status: 'missing', enabled: 1, health_status: 'healthy', blocked_until: null },
    ];
  }
}

function expiredJob(id, operation, replicaId = null) {
  return {
    ...jobInput(id),
    operation,
    replica_id: replicaId,
    status: 'running',
    lease_until: Date.now() - 1,
  };
}

class ConsumerRepository {
  constructor({ job, file, tombstone } = {}) {
    this.job = { ...jobInput('job_duplicate'), ...(job || {}), status: 'queued', attempts: 0, max_attempts: 3 };
    this.file = file || { id: 'file_1', generation: 1, status: 'available' };
    this.tombstone = tombstone || null;
    this.claims = 0;
  }
  async getJob(id) { return id === this.job.id ? this.job : null; }
  async claimJob(id) {
    this.claims += 1;
    if (id !== this.job.id || !['pending', 'queued', 'retry_wait'].includes(this.job.status)) return null;
    this.job.status = 'running';
    this.job.attempts += 1;
    return this.job;
  }
  async getFile() { return this.file; }
  async getTombstone() { return this.tombstone; }
  async getReplica() { return null; }
  async updateJob(_id, status) { this.job.status = status; return this.job; }
}

class DeletionRecoveryRepository {
  constructor() {
    this.job = { ...jobInput('job_delete_recovery'), replica_id: 'replica_1', channel_id: 'channel_1', operation: 'DELETE_REPLICA', generation: 2, status: 'queued', attempts: 0, max_attempts: 1 };
    this.file = { id: 'file_1', generation: 2, status: 'deleting' };
    this.tombstone = { file_id: 'file_1', generation: 2 };
    this.replica = { id: 'replica_1', channel_id: 'channel_1', object_key: 'file_1/a.txt', remote_id: null, remote_metadata_json: '{}', status: 'deleting' };
    this.claims = 0;
  }
  async getJob(id) { return id === this.job.id ? this.job : null; }
  async claimJob(id) { this.claims += 1; if (id !== this.job.id || !['pending', 'queued', 'retry_wait'].includes(this.job.status)) return null; this.job.status = 'running'; this.job.attempts += 1; return this.job; }
  async getFile() { return this.file; }
  async getTombstone() { return this.tombstone; }
  async getReplica() { return this.replica; }
  async updateReplica(_id, patch) { Object.assign(this.replica, patch); return this.replica; }
  async updateFileStatus(_id, status) { this.file.status = status; return this.file; }
  async updateJob(_id, status) { this.job.status = status; return this.job; }
  async finalizeDeletion() { if (this.replica.status === 'deleted') this.file.status = 'deleted'; return this.file; }
}

class UncertainWriteRepository extends ConsumerRepository {
  constructor() {
    super({
      job: { ...jobInput('job_uncertain_write'), operation: 'REPAIR_REPLICA', replica_id: 'replica_target', channel_id: 'channel_target', generation: 1 },
      file: { id: 'file_1', generation: 1, status: 'available', size: 3, content_type: 'text/plain', name: 'demo.txt' },
    });
    this.source = { id: 'replica_source', channel_id: 'channel_source', status: 'healthy', enabled: 1, health_status: 'healthy', object_key: 'file_1/demo.txt', remote_id: 'source', remote_metadata_json: '{}' };
    this.target = { id: 'replica_target', channel_id: 'channel_target', role: 'sync_backup', status: 'retry_wait', enabled: 1, health_status: 'healthy', object_key: 'file_1/demo.txt', remote_id: null, remote_metadata_json: '{}' };
    this.failAcknowledgement = true;
  }
  async getReplica(id) { return id === this.target.id ? this.target : id === this.source.id ? this.source : null; }
  async listReplicas() { return [this.source, this.target]; }
  async getChannel(id) { return { id, enabled: 1, health_status: 'healthy', config_json: '{}', secret_refs_json: '{}' }; }
  async updateReplica(id, patch) {
    const replica = await this.getReplica(id);
    if (id === this.target.id && patch.status === 'healthy' && this.failAcknowledgement) {
      const error = new Error('D1 acknowledgement interrupted after remote write');
      error.code = 'D1_UNAVAILABLE';
      throw error;
    }
    Object.assign(replica, patch);
    return replica;
  }
}

function consumerApp(repository) {
  return {
    repository,
    guard: { async assertRepair() {}, async assertAsyncReplica() {}, async assertVerify() {}, async assertDelete() {}, async assertWrite() {} },
    health: { async recordFailure() {}, async recordSuccess() {} },
    storage: { recounts: 0, async recomputeFileHealth() { this.recounts += 1; } },
  };
}

function deletionApp(repository, remove, guard = { async assertDelete() {} }) {
  return {
    repository,
    adapterFor: async () => ({ delete: remove }),
    guard,
    health: { async recordFailure() {}, async recordSuccess() {} },
    storage: { async recomputeFileHealth() {} },
  };
}

function uncertainWriteApp(repository, put) {
  return {
    repository,
    adapterFor: async () => ({ put }),
    guard: { async assertRepair() {}, async assertAsyncReplica() {}, async assertVerify() {}, async assertDelete() {}, async assertWrite() {} },
    health: { async recordFailure() {}, async recordSuccess() {} },
    storage: {
      async openReplica() { return new Response('abc'); },
      async recomputeFileHealth() {},
    },
  };
}

function queueMessage(jobId) {
  return {
    body: { v: 1, jobId, fileId: 'file_1', operation: 'RECOUNT_FILE_HEALTH' },
    acks: 0,
    retries: 0,
    ack() { this.acks += 1; },
    retry() { this.retries += 1; },
  };
}
