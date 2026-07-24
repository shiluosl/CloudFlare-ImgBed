import { assertJobTransition } from '../state/statusMachine.js';

export class JobService {
  constructor(repository, guard, queue = null) { this.repository = repository; this.guard = guard; this.queue = queue; }
  async create(input, { essential = false } = {}) {
    const job = await this.repository.createJob(input);
    if (!job || job.status !== 'pending' || !this.queue) return job;
    try { await this.enqueue(job, { essential }); } catch (error) { return job; }
    return this.repository.getJob(job.id);
  }
  async enqueue(job, { essential = false } = {}) {
    await this.guard.assertQueue({ essential });
    assertJobTransition(job.status, 'queued');
    const message = { v: 1, jobId: job.id, fileId: job.file_id, replicaId: job.replica_id, operation: job.operation };
    await this.queue.send(message); await this.repository.updateJob(job.id, 'queued'); await this.guard.record({ queue_operations: 1 });
  }
  async redispatchDue(limit = 50, { level } = {}) {
    const protectionLevel = level || await this.protectionLevel();
    if (protectionLevel === 'EMERGENCY') return { dispatched: 0, recovered: 0, protectionLevel };

    const recovered = await this.recoverEligibleLeases(limit, protectionLevel);
    const jobs = await this.repository.dueJobs(limit); let dispatched = 0;
    for (const job of jobs) {
      const essential = await this.isEssentialJob(job);
      if (!isRedispatchAllowed(job, protectionLevel, essential)) continue;
      try { await this.enqueue(job, { essential }); dispatched += 1; } catch { break; }
    }
    return { dispatched, recovered, protectionLevel };
  }
  async retry(jobId) {
    const job = await this.repository.getJob(jobId);
    if (!job) return null;
    if (!['pending', 'dead', 'retry_wait', 'queued'].includes(job.status)) throw new Error('Only pending, dead, retry_wait, or queued jobs can be retried');
    const essential = await this.isEssentialJob(job);
    if (job.operation === 'DELETE_REPLICA') await this.guard.assertDelete({ admin: true });
    if (job.operation === 'VERIFY_REPLICA') await this.guard.assertVerify();
    if (['CREATE_REPLICA', 'REPAIR_REPLICA'].includes(job.operation)) await this.guard.assertRepair({ critical: essential });
    if (['RECOUNT_FILE_HEALTH', 'RECONCILE_FILE'].includes(job.operation)) await this.guard.assertWrite();
    const pending = await this.repository.updateJob(jobId, 'pending', { runAfter: Date.now() });
    if (this.queue) await this.enqueue(pending, { essential });
    return this.repository.getJob(jobId);
  }
  async isEssentialJob(job) {
    if (job.operation === 'DELETE_REPLICA') return true;
    if (!['CREATE_REPLICA', 'REPAIR_REPLICA'].includes(job.operation) || !job.replica_id) return false;
    const replica = await this.repository.getReplica(job.replica_id);
    if (!replica || !['primary', 'sync_backup'].includes(replica.role)) return false;
    const file = await this.repository.getFile(job.file_id);
    if (!file || !['degraded', 'failed'].includes(file.status)) return false;
    const replicas = await this.repository.listReplicas(job.file_id);
    return replicas.filter(isReadableReplica).length === 1;
  }
  async protectionLevel() {
    if (!this.guard?.status) return 'NORMAL';
    return (await this.guard.status()).level || 'NORMAL';
  }
  async recoverEligibleLeases(limit, protectionLevel) {
    if (this.repository.listExpiredLeases && this.repository.recoverExpiredLeasesByIds) {
      const expired = await this.repository.listExpiredLeases(limit);
      const allowed = [];
      for (const job of expired) {
        const essential = await this.isEssentialJob(job);
        if (isRedispatchAllowed(job, protectionLevel, essential)) allowed.push(job.id);
      }
      return allowed.length ? this.repository.recoverExpiredLeasesByIds(allowed) : 0;
    }
    // An older repository cannot filter expired leases by job identity. In a
    // restricted mode, leave leases untouched rather than risk reviving normal
    // work through a broad recovery update.
    if (protectionLevel === 'READ_ONLY' || protectionLevel === 'WRITE_LIMITED') {
      return 0;
    }
    return this.repository.recoverExpiredLeases(limit);
  }
  async cancel(jobId) {
    const job = await this.repository.getJob(jobId);
    if (!job) return null;
    if (!['pending', 'queued', 'retry_wait'].includes(job.status)) throw new Error('Only pending jobs can be cancelled');
    return this.repository.updateJob(jobId, 'cancelled');
  }
}

function isRedispatchAllowed(job, protectionLevel, essential) {
  if (protectionLevel === 'NORMAL' || protectionLevel === 'WARNING') return true;
  if (protectionLevel === 'READ_ONLY') return job.operation === 'DELETE_REPLICA';
  if (protectionLevel === 'WRITE_LIMITED') return job.operation === 'DELETE_REPLICA' || essential;
  return false;
}

function isReadableReplica(replica) {
  return replica.status === 'healthy' && replica.enabled !== 0
    && !['offline', 'disabled', 'quota_blocked'].includes(replica.health_status)
    && (!replica.blocked_until || Number(replica.blocked_until) <= Date.now());
}
