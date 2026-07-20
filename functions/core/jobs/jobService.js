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
    const jobs = await this.repository.dueJobs(limit); let dispatched = 0;
    for (const job of jobs) { try { await this.enqueue(job, { essential: job.operation === 'DELETE_REPLICA' }); dispatched += 1; } catch { break; } }
    return dispatched;
  }
  async retry(jobId) {
    const job = await this.repository.getJob(jobId);
    if (!job) return null;
    if (!['dead', 'retry_wait'].includes(job.status)) throw new Error('Only dead or retry_wait jobs can be retried');
    const pending = await this.repository.updateJob(jobId, 'pending', { runAfter: Date.now() });
    if (this.queue) await this.enqueue(pending, { essential: pending.operation === 'DELETE_REPLICA' });
    return this.repository.getJob(jobId);
  }
  async cancel(jobId) {
    const job = await this.repository.getJob(jobId);
    if (!job) return null;
    if (!['pending', 'queued', 'retry_wait'].includes(job.status)) throw new Error('Only pending jobs can be cancelled');
    return this.repository.updateJob(jobId, 'cancelled');
  }
}
