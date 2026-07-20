import { runtime } from '../core/runtime.js';
import { ChannelHealthService } from '../core/health/channelHealthService.js';

export async function runMaintenance(env) {
  const app = runtime(env);
  const redispatch = await app.jobs.redispatchDue(50);
  const status = await app.guard.status();
  if (status.level === 'EMERGENCY' || status.level === 'READ_ONLY') return { ...redispatch, checked: 0, scheduled: 0, protectionLevel: status.level };
  let scheduled = 0;
  if (status.level === 'NORMAL') {
    const replicas = await selectRotatingReplicaMaintenance(app.repository, replicaMaintenanceLimit(env), Date.now() - replicaVerifyInterval(env));
    scheduled = await scheduleReplicaMaintenance(app, replicas, env);
  } else if (status.level === 'WRITE_LIMITED') {
    const replicas = await selectRotatingCriticalReplicaMaintenance(app.repository, replicaMaintenanceLimit(env));
    scheduled = await scheduleReplicaMaintenance(app, replicas, env, { essentialRepair: true });
  }
  if (status.level !== 'NORMAL') return { ...redispatch, checked: 0, scheduled, protectionLevel: status.level };
  const channels = await selectRotatingHealthCheckChannels(app.repository);
  const health = new ChannelHealthService(app.repository, env);
  let checked = 0;
  for (const channel of channels.filter(channel => channel.enabled)) {
    await health.check(channel.id);
    checked += 1;
  }
  return { ...redispatch, checked, scheduled, protectionLevel: status.level };
}

export async function selectRotatingHealthCheckChannels(repository, limit = 5) {
  const cursorName = 'channel_health_cursor';
  const cursor = await repository.getMaintenanceCursor(cursorName);
  let channels = await repository.listChannelsAfter(cursor, limit);
  if (!channels.length && cursor) channels = await repository.listChannelsAfter(0, limit);
  if (channels.length) await repository.setMaintenanceCursor(cursorName, channels.at(-1).cursor);
  return channels;
}

export async function selectRotatingReplicaMaintenance(repository, limit = 5, verifyBefore = Date.now()) {
  const cursorName = 'replica_maintenance_cursor';
  const cursor = await repository.getMaintenanceCursor(cursorName);
  let replicas = await repository.listReplicaMaintenanceAfter(cursor, limit, verifyBefore);
  if (!replicas.length && cursor) replicas = await repository.listReplicaMaintenanceAfter(0, limit, verifyBefore);
  if (replicas.length) await repository.setMaintenanceCursor(cursorName, replicas.at(-1).cursor);
  return replicas;
}

export async function selectRotatingCriticalReplicaMaintenance(repository, limit = 5) {
  const cursorName = 'critical_replica_maintenance_cursor';
  const cursor = await repository.getMaintenanceCursor(cursorName);
  let replicas = await repository.listCriticalReplicaMaintenanceAfter(cursor, limit);
  if (!replicas.length && cursor) replicas = await repository.listCriticalReplicaMaintenanceAfter(0, limit);
  if (replicas.length) await repository.setMaintenanceCursor(cursorName, replicas.at(-1).cursor);
  return replicas;
}

export async function scheduleReplicaMaintenance(app, replicas, env = {}, { essentialRepair = false } = {}) {
  let scheduled = 0;
  const verificationBucket = Math.floor(Date.now() / replicaVerifyInterval(env));
  const repairBucket = Math.floor(Date.now() / replicaRepairInterval(env));
  for (const replica of replicas) {
    const operation = ['healthy', 'suspect'].includes(replica.status)
      ? 'VERIFY_REPLICA'
      : replica.status === 'planned' && replica.role === 'async_backup' ? 'CREATE_REPLICA' : 'REPAIR_REPLICA';
    const bucket = operation === 'VERIFY_REPLICA' ? verificationBucket : repairBucket;
    await app.jobs.create({
      id: `job_${crypto.randomUUID()}`,
      fileId: replica.file_id,
      replicaId: replica.id,
      channelId: replica.channel_id,
      operation,
      generation: replica.file_generation,
      idempotencyKey: `maintenance:${operation}:${replica.file_id}:${replica.id}:${replica.file_generation}:${bucket}`,
    }, { essential: essentialRepair && operation !== 'VERIFY_REPLICA' });
    scheduled += 1;
  }
  return scheduled;
}

function replicaMaintenanceLimit(env) { return clamp(env.V3_REPLICA_MAINTENANCE_BATCH_SIZE, 5, 1, 10); }
function replicaVerifyInterval(env) { return clamp(env.V3_REPLICA_VERIFY_INTERVAL_MS, 6 * 60 * 60 * 1000, 15 * 60 * 1000, 7 * 24 * 60 * 60 * 1000); }
function replicaRepairInterval(env) { return clamp(env.V3_REPLICA_REPAIR_INTERVAL_MS, 15 * 60 * 1000, 5 * 60 * 1000, 24 * 60 * 60 * 1000); }
function clamp(value, fallback, minimum, maximum) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback; }
