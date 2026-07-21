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
  async redispatchDue(limit = 50) {
    const recovered = await this.repository.recoverExpiredLeases(limit);
    const jobs = await this.repository.dueJobs(limit); let dispatched = 0;
    for (const job of jobs) { try { await this.enqueue(job, { essential: await this.isEssentialJob(job) }); dispatched += 1; } catch { break; } }
    return { dispatched, recovered };
  }
  async retry(jobId) {
    const job = await this.repository.getJob(jobId);
    if (!job) return null;
    if (!['dead', 'retry_wait'].includes(job.status)) throw new Error('Only dead or retry_wait jobs can be retried');
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
    const replicas = await this.repository.listReplicas(job.file_id);
    return replicas.filter(isReadableReplica).length === 1;
  }
  async cancel(jobId) {
    const job = await this.repository.getJob(jobId);
    if (!job) return null;
    if (!['pending', 'queued', 'retry_wait'].includes(job.status)) throw new Error('Only pending jobs can be cancelled');
    return this.repository.updateJob(jobId, 'cancelled');
  }
}

function isReadableReplica(replica) {
  return replica.status === 'healthy' && replica.enabled !== 0
    && !['offline', 'disabled', 'quota_blocked'].includes(replica.health_status)
    && (!replica.blocked_until || Number(replica.blocked_until) <= Date.now());
}
