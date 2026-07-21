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
      await assertJobAllowed(app, job, file, replica);
      await executeStorageJob(app, env, job, file, replica);
      await app.repository.updateJob(job.id, 'succeeded');
      message.ack();
    } catch (error) {
      if (error.code === 'ZERO_COST_GUARD') {
        await app.repository.deferJobForGuard(job.id, error.level);
        message.ack();
        continue;
      }
      if (error.code === 'CHANNEL_UNAVAILABLE' && app.repository.deferJobForChannel) {
        await app.repository.deferJobForChannel(job.id, error.channel);
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
    try {
      const info = await (await adapterFor(app, env, replica.channel_id)).head({ objectKey: replica.object_key, remoteId: replica.remote_id });
      if (info.size !== null && Number(info.size) !== Number(file.size)) throw Object.assign(new Error('Replica size mismatch'), { code: 'CHECKSUM_MISMATCH' });
      await app.repository.updateReplica(replica.id, { status: 'healthy', size: info.size, etag: info.etag, last_checked_at: Date.now() });
      await app.health?.recordSuccess({ channel_id: replica.channel_id });
      await app.storage.recomputeFileHealth(file.id);
    } catch (error) {
      const status = verificationFailureStatus(error);
      if (!status) throw error;
      await handleVerificationFailure(app, job, file, replica, status, error);
    }
    return;
  }
  if (['REPAIR_REPLICA', 'CREATE_REPLICA'].includes(job.operation) && replica) {
    const source = (await app.repository.listReplicas(file.id)).find(item => item.id !== replica.id && isReadableSource(item));
    if (!source) throw Object.assign(new Error('No healthy source replica is available'), { code: 'NO_HEALTHY_SOURCE' });
    const adapter = await writableAdapterFor(app, env, replica.channel_id);
    const sourceResponse = await app.storage.openReplica(source);
    await app.repository.updateReplica(replica.id, { status: 'uploading' });
    const stored = await adapter.put({ fileId: file.id, objectKey: replica.object_key, body: sourceResponse.body, size: file.size, contentType: file.content_type, name: file.name, idempotencyKey: job.idempotency_key, generation: file.generation });
    if (stored.size !== null && stored.size !== undefined && Number(stored.size) !== Number(file.size)) {
      await app.repository.updateReplica(replica.id, { status: 'corrupt', last_error_code: 'CHECKSUM_MISMATCH', last_error_message: 'Repaired replica size does not match logical file size' });
      await app.storage.recomputeFileHealth(file.id);
      throw Object.assign(new Error('Repaired replica size mismatch'), { code: 'CHECKSUM_MISMATCH' });
    }
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

async function assertJobAllowed(app, job, file, replica) {
  const { guard } = app;
  if (!guard) return;
  if (job.operation === 'DELETE_REPLICA') return guard.assertDelete({ admin: true });
  if (job.operation === 'VERIFY_REPLICA') return guard.assertVerify();
  const criticalRepair = await isCriticalRepair(app.repository, file, replica);
  if (job.operation === 'CREATE_REPLICA') return replica?.role === 'async_backup'
    ? guard.assertAsyncReplica()
    : guard.assertRepair({ critical: criticalRepair });
  if (job.operation === 'REPAIR_REPLICA') return guard.assertRepair({ critical: criticalRepair });
  if (['RECOUNT_FILE_HEALTH', 'RECONCILE_FILE'].includes(job.operation)) return guard.assertWrite();
}

async function isCriticalRepair(repository, file, replica) {
  if (!replica || !['primary', 'sync_backup'].includes(replica.role) || !['degraded', 'failed'].includes(file.status)) return false;
  const replicas = await repository.listReplicas(file.id);
  return replicas.filter(isReadableSource).length === 1;
}

async function adapterFor(app, env, channelId) {
  if (app.adapterFor) return app.adapterFor(channelId);
  const channel = await app.repository.getChannel(channelId);
  if (!channel) throw Object.assign(new Error('Storage channel no longer exists'), { code: 'CHANNEL_NOT_FOUND' });
  return getAdapter({ ...channel, config: safeJson(channel.config_json), secretRefs: safeJson(channel.secret_refs_json) }, env);
}

async function writableAdapterFor(app, env, channelId) {
  const channel = await app.repository.getChannel(channelId);
  if (!channel) throw Object.assign(new Error('Storage channel no longer exists'), { code: 'CHANNEL_NOT_FOUND' });
  const blockedUntil = Number(channel.blocked_until || 0);
  if (!channel.enabled || ['offline', 'disabled', 'quota_blocked'].includes(channel.health_status) || blockedUntil > Date.now()) {
    const error = Object.assign(new Error('Storage channel is not writable'), { code: 'CHANNEL_UNAVAILABLE', channel });
    if (blockedUntil > Date.now()) error.retryAfterSeconds = Math.ceil((blockedUntil - Date.now()) / 1000);
    throw error;
  }
  if (app.adapterFor) return app.adapterFor(channelId);
  return getAdapter({ ...channel, config: safeJson(channel.config_json), secretRefs: safeJson(channel.secret_refs_json) }, env);
}

async function handleVerificationFailure(app, job, file, replica, status, error) {
  await app.repository.updateReplica(replica.id, {
    status,
    last_checked_at: Date.now(),
    last_error_code: error.code,
    last_error_message: safeMessage(error),
  });
  await app.health?.recordFailure({ channel_id: replica.channel_id }, error);
  const updated = await app.storage.recomputeFileHealth(file.id);
  await audit(app.repository, 'replica.verificationFailed', replica.id, { status, code: error.code });
  const policy = app.repository.getPolicy ? await app.repository.getPolicy(file.policy_id) : null;
  if (policy && !policy.auto_repair) return;
  const source = (await app.repository.listReplicas(file.id)).find(item => item.id !== replica.id && isReadableSource(item));
  if (!source || !app.jobs) return;
  try {
    await app.guard?.assertRepair({ critical: await isCriticalRepair(app.repository, updated || file, replica) });
    await app.jobs.create({
      id: `job_${crypto.randomUUID()}`,
      fileId: file.id,
      replicaId: replica.id,
      channelId: replica.channel_id,
      operation: 'REPAIR_REPLICA',
      generation: file.generation,
      idempotencyKey: `verify-repair:${job.id}:${replica.id}:${file.generation}`,
    });
    await audit(app.repository, 'replica.repairScheduled', replica.id, { reason: error.code, sourceReplicaId: source.id });
  } catch (repairError) {
    if (repairError.code !== 'ZERO_COST_GUARD') throw repairError;
  }
}

function verificationFailureStatus(error) {
  if (error?.code === 'NOT_FOUND') return 'missing';
  if (error?.code === 'CHECKSUM_MISMATCH') return 'corrupt';
  return null;
}
function isReadableSource(replica) { return replica.status === 'healthy' && replica.enabled !== 0 && !['offline', 'disabled', 'quota_blocked'].includes(replica.health_status) && (!replica.blocked_until || Number(replica.blocked_until) <= Date.now()); }
async function audit(repository, action, targetId, details) { if (repository.audit) await repository.audit({ id: `audit_${crypto.randomUUID()}`, action, targetType: 'file_replica', targetId, details }); }

function safeJson(value) { try { return JSON.parse(value || '{}'); } catch { return {}; } }
function retryDelay(attempts, retryAfterSeconds) { return retryAfterSeconds ? retryAfterSeconds * 1000 : 60000 * Math.min(Math.max(1, attempts), 15); }
function safeMessage(error) { return String(error?.message || 'Storage job failed').replace(/(bearer|basic)\s+[^\s]+/gi, '$1 [redacted]').slice(0, 500); }
