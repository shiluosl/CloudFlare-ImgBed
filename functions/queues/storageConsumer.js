import { runtime } from '../core/runtime.js';
import { getAdapter } from '../core/storage/registry.js';

export async function consumeStorageJobs(batch, env, appFactory = runtime) {
  const app = appFactory(env);
  for (const message of batch.messages) {
    const job = await app.repository.claimJob(message.body?.jobId);
    if (!job) {
      message.ack();
      continue;
    }
    try {
      const file = await app.repository.getFile(job.file_id);
      const tombstone = await app.repository.getTombstone(job.file_id);
      if (!isExecutableStorageJob(job, file, tombstone)) {
        await app.repository.updateJob(job.id, 'cancelled');
        message.ack();
        continue;
      }
      const replica = job.replica_id ? await app.repository.getReplica(job.replica_id) : null;
      await assertJobAllowed(app.guard, job, file, replica);
      await executeStorageJob(app, env, job, file, replica);
      await app.repository.updateJob(job.id, 'succeeded');
      message.ack();
    } catch (error) {
      if (error.code === 'ZERO_COST_GUARD') {
        await app.repository.deferJobForGuard(job.id, error.level);
        message.ack();
        continue;
      }
      await app.health?.recordFailure({ channel_id: job.channel_id }, error);
      const retry = job.attempts < job.max_attempts;
      await app.repository.updateJob(job.id, retry ? 'retry_wait' : 'dead', {
        runAfter: Date.now() + retryDelay(job.attempts, error.retryAfterSeconds),
        errorCode: error.code || 'UNKNOWN',
        errorMessage: safeMessage(error),
      });
      if (!retry && job.operation === 'DELETE_REPLICA') {
        const current = await app.repository.getFile(job.file_id);
        if (current?.status === 'deleting') await app.repository.updateFileStatus(job.file_id, 'delete_degraded');
      }
      retry ? message.retry() : message.ack();
    }
  }
}

export function isExecutableStorageJob(job, file, tombstone) {
  if (!file) return false;
  if (job.operation === 'DELETE_REPLICA') return Boolean(tombstone) && file.generation === job.generation && tombstone.generation === job.generation;
  return !tombstone && !['deleting', 'delete_degraded', 'deleted'].includes(file.status) && file.generation === job.generation;
}

export async function executeStorageJob(app, env, job, file, replica) {
  if (job.operation === 'DELETE_REPLICA') {
    if (replica && replica.status !== 'deleted') {
      const adapter = await adapterFor(app, env, replica.channel_id);
      await adapter.delete({ objectKey: replica.object_key, remoteId: replica.remote_id, safeMetadata: safeJson(replica.remote_metadata_json) });
      await app.repository.updateReplica(replica.id, { status: 'deleted' });
      await app.health?.recordSuccess({ channel_id: replica.channel_id });
    }
    await app.repository.finalizeDeletion(file.id);
    return;
  }
  if (job.operation === 'VERIFY_REPLICA' && replica) {
    const info = await (await adapterFor(app, env, replica.channel_id)).head({ objectKey: replica.object_key, remoteId: replica.remote_id });
    if (info.size !== null && Number(info.size) !== Number(file.size)) throw Object.assign(new Error('Replica size mismatch'), { code: 'CHECKSUM_MISMATCH' });
    await app.repository.updateReplica(replica.id, { status: 'healthy', size: info.size, etag: info.etag, last_checked_at: Date.now() });
    await app.health?.recordSuccess({ channel_id: replica.channel_id });
    await app.storage.recomputeFileHealth(file.id);
    return;
  }
  if (['REPAIR_REPLICA', 'CREATE_REPLICA'].includes(job.operation) && replica) {
    const source = (await app.repository.listReplicas(file.id)).find(item => item.id !== replica.id && item.status === 'healthy');
    if (!source) throw Object.assign(new Error('No healthy source replica is available'), { code: 'NO_HEALTHY_SOURCE' });
    const sourceResponse = await app.storage.openReplica(source);
    const adapter = await adapterFor(app, env, replica.channel_id);
    await app.repository.updateReplica(replica.id, { status: 'uploading' });
    const stored = await adapter.put({ fileId: file.id, objectKey: replica.object_key, body: sourceResponse.body, size: file.size, contentType: file.content_type, name: file.name, idempotencyKey: job.idempotency_key, generation: file.generation });
    await app.repository.updateReplica(replica.id, { status: 'healthy', remote_id: stored.remoteId, remote_metadata_json: JSON.stringify(stored.safeMetadata || {}), etag: stored.etag, checksum: stored.checksum, size: stored.size, last_success_at: Date.now() });
    await app.health?.recordSuccess({ channel_id: replica.channel_id });
    await app.storage.recomputeFileHealth(file.id);
    return;
  }
  if (job.operation === 'RECOUNT_FILE_HEALTH' || job.operation === 'RECONCILE_FILE') {
    await app.storage.recomputeFileHealth(file.id);
    return;
  }
  throw Object.assign(new Error(`Unsupported storage job: ${job.operation}`), { code: 'UNSUPPORTED_JOB' });
}

async function assertJobAllowed(guard, job, file, replica) {
  if (!guard) return;
  if (job.operation === 'DELETE_REPLICA') return guard.assertDelete({ admin: true });
  if (job.operation === 'VERIFY_REPLICA') return guard.assertVerify();
  if (job.operation === 'CREATE_REPLICA') return replica?.role === 'async_backup'
    ? guard.assertAsyncReplica()
    : guard.assertRepair({ critical: file.status === 'failed' });
  if (job.operation === 'REPAIR_REPLICA') return guard.assertRepair({ critical: file.status === 'failed' });
}

async function adapterFor(app, env, channelId) {
  const channel = await app.repository.getChannel(channelId);
  if (!channel) throw Object.assign(new Error('Storage channel no longer exists'), { code: 'CHANNEL_NOT_FOUND' });
  return getAdapter({ ...channel, config: safeJson(channel.config_json), secretRefs: safeJson(channel.secret_refs_json) }, env);
}

function safeJson(value) { try { return JSON.parse(value || '{}'); } catch { return {}; } }
function retryDelay(attempts, retryAfterSeconds) { return retryAfterSeconds ? retryAfterSeconds * 1000 : 60000 * Math.min(Math.max(1, attempts), 15); }
function safeMessage(error) { return String(error?.message || 'Storage job failed').replace(/(bearer|basic)\s+[^\s]+/gi, '$1 [redacted]').slice(0, 500); }
