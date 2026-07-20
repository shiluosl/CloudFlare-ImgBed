import { all, first, json, now, page } from './d1.js';
import { assertFileTransition, assertJobTransition, assertReplicaTransition } from '../core/state/statusMachine.js';

export class StorageRepository {
  constructor(db) { this.db = db; }

  async createChannel(channel) {
    const time = now();
    await this.db.prepare(`INSERT INTO storage_channels
      (id,name,provider,enabled,failure_domain,priority,health_status,config_json,secret_refs_json,capabilities_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(channel.id, channel.name, channel.provider,
      channel.enabled === false ? 0 : 1, channel.failureDomain, channel.priority ?? 100,
      channel.healthStatus || 'unknown', JSON.stringify(channel.config || {}),
      JSON.stringify(channel.secretRefs || {}), JSON.stringify(channel.capabilities || {}), time, time).run();
    return this.getChannel(channel.id);
  }

  async getChannel(id) { return first(this.db.prepare('SELECT * FROM storage_channels WHERE id = ?').bind(id)); }
  async listChannels({ limit, cursor } = {}) {
    const p = page(limit, cursor);
    return all(this.db.prepare('SELECT rowid AS cursor, * FROM storage_channels WHERE rowid > ? ORDER BY rowid LIMIT ?').bind(p.cursor, p.limit));
  }
  async listChannelsAfter(cursor, limit = 5) {
    const safeCursor = Number(cursor) || 0;
    const safeLimit = Math.min(Math.max(Number(limit) || 5, 1), 20);
    return all(this.db.prepare('SELECT rowid AS cursor, * FROM storage_channels WHERE rowid > ? ORDER BY rowid LIMIT ?').bind(safeCursor, safeLimit));
  }
  async getMaintenanceCursor(name) {
    const row = await first(this.db.prepare('SELECT cursor FROM maintenance_state WHERE name=?').bind(name));
    return row?.cursor || 0;
  }
  async setMaintenanceCursor(name, cursor) {
    await this.db.prepare(`INSERT INTO maintenance_state(name,cursor,updated_at) VALUES(?,?,?)
      ON CONFLICT(name) DO UPDATE SET cursor=excluded.cursor, updated_at=excluded.updated_at`).bind(name, Number(cursor) || 0, now()).run();
  }
  async setChannelHealth(id, status, patch = {}) {
    const time = now();
    await this.db.prepare(`UPDATE storage_channels SET health_status=?, consecutive_failures=?, consecutive_successes=?, blocked_until=?, last_success_at=?, last_failure_at=?, last_error_code=?, last_error_message=?, updated_at=? WHERE id=?`)
      .bind(status, patch.consecutiveFailures ?? 0, patch.consecutiveSuccesses ?? 0, patch.blockedUntil ?? null,
        patch.lastSuccessAt ?? null, patch.lastFailureAt ?? null, patch.errorCode ?? null, patch.errorMessage ?? null, time, id).run();
    return this.getChannel(id);
  }
  async setChannelEnabled(id, enabled) {
    const status = enabled ? 'unknown' : 'disabled';
    await this.db.prepare('UPDATE storage_channels SET enabled=?, health_status=?, updated_at=? WHERE id=?').bind(enabled ? 1 : 0, status, now(), id).run();
    return this.getChannel(id);
  }

  async createPolicy(policy) {
    const time = now();
    await this.db.prepare(`INSERT INTO storage_policies
      (id,name,enabled,write_mode,primary_channel_id,sync_backup_channel_id,async_channels_json,required_copies,minimum_readable_copies,auto_repair,stop_when_quota_risk,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(policy.id, policy.name, policy.enabled === false ? 0 : 1,
      policy.writeMode || 'safe', policy.primaryChannelId, policy.syncBackupChannelId || null,
      JSON.stringify(policy.asyncChannelIds || []), policy.requiredCopies || 2, policy.minimumReadableCopies || 1,
      policy.autoRepair === false ? 0 : 1, policy.stopWhenQuotaRisk === false ? 0 : 1, time, time).run();
    return this.getPolicy(policy.id);
  }
  async getPolicy(id) { return first(this.db.prepare('SELECT * FROM storage_policies WHERE id=?').bind(id)); }
  async getPolicyWithChannels(id) {
    const policy = await this.getPolicy(id);
    if (!policy) return null;
    return { ...policy, async_channels: json(policy.async_channels_json, []) };
  }
  async listPolicies({ limit, cursor } = {}) {
    const p = page(limit, cursor);
    return all(this.db.prepare('SELECT rowid AS cursor, * FROM storage_policies WHERE rowid > ? ORDER BY rowid LIMIT ?').bind(p.cursor, p.limit));
  }
  async updatePolicy(id, patch) {
    const current = await this.getPolicy(id);
    if (!current) return null;
    const allowed = {
      name: 'name', enabled: 'enabled', writeMode: 'write_mode', primaryChannelId: 'primary_channel_id',
      syncBackupChannelId: 'sync_backup_channel_id', asyncChannelIds: 'async_channels_json', requiredCopies: 'required_copies',
      minimumReadableCopies: 'minimum_readable_copies', autoRepair: 'auto_repair', stopWhenQuotaRisk: 'stop_when_quota_risk',
    };
    const entries = Object.entries(patch).filter(([key, value]) => allowed[key] && value !== undefined)
      .map(([key, value]) => [allowed[key], ['asyncChannelIds'].includes(key) ? JSON.stringify(value || []) : ['enabled', 'autoRepair', 'stopWhenQuotaRisk'].includes(key) ? (value ? 1 : 0) : value]);
    if (!entries.length) return current;
    await this.db.prepare(`UPDATE storage_policies SET ${entries.map(([column]) => `${column}=?`).join(',')}, updated_at=? WHERE id=?`)
      .bind(...entries.map(([, value]) => value), now(), id).run();
    return this.getPolicy(id);
  }

  async createFileWithReplicas(file, replicas) {
    const time = now();
    const statements = [this.db.prepare(`INSERT INTO files_v3
      (id,generation,idempotency_key,owner_id,policy_id,status,name,content_type,size,is_public,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(file.id, file.generation || 1, file.idempotencyKey || null,
      file.ownerId || null, file.policyId, file.status || 'receiving', file.name, file.contentType, file.size,
      file.isPublic === false ? 0 : 1, time, time)];
    for (const replica of replicas) {
      statements.push(this.db.prepare(`INSERT INTO file_replicas
        (id,file_id,channel_id,role,generation,object_key,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).bind(replica.id, file.id, replica.channelId, replica.role,
        file.generation || 1, replica.objectKey, replica.status || 'planned', time, time));
    }
    await this.db.batch(statements);
    return this.getFile(file.id);
  }
  async getFile(id) { return first(this.db.prepare('SELECT * FROM files_v3 WHERE id=?').bind(id)); }
  async getFileByIdempotency(key) { return key ? first(this.db.prepare('SELECT * FROM files_v3 WHERE idempotency_key=?').bind(key)) : null; }
  async listFiles({ limit, cursor, status } = {}) {
    const p = page(limit, cursor);
    const base = status ? 'SELECT rowid AS cursor, * FROM files_v3 WHERE rowid > ? AND status=? ORDER BY rowid LIMIT ?' : 'SELECT rowid AS cursor, * FROM files_v3 WHERE rowid > ? ORDER BY rowid LIMIT ?';
    return all(status ? this.db.prepare(base).bind(p.cursor, status, p.limit) : this.db.prepare(base).bind(p.cursor, p.limit));
  }
  async listReplicas(fileId) { return all(this.db.prepare(`SELECT r.*, c.provider, c.priority, c.health_status, c.enabled
      FROM file_replicas r JOIN storage_channels c ON c.id=r.channel_id WHERE r.file_id=? ORDER BY CASE r.role WHEN 'primary' THEN 0 ELSE 1 END, c.priority`).bind(fileId)); }
  async getReplica(id) { return first(this.db.prepare('SELECT * FROM file_replicas WHERE id=?').bind(id)); }
  async switchPrimaryReplica(fileId, replicaId) {
    const replica = await this.getReplica(replicaId);
    if (!replica || replica.file_id !== fileId || replica.status !== 'healthy') return null;
    await this.db.batch([
      this.db.prepare("UPDATE file_replicas SET role='sync_backup', updated_at=? WHERE file_id=? AND role='primary' AND id<>?").bind(now(), fileId, replicaId),
      this.db.prepare("UPDATE file_replicas SET role='primary', updated_at=? WHERE id=? AND file_id=? AND status='healthy'").bind(now(), replicaId, fileId),
    ]);
    return this.getReplica(replicaId);
  }
  async updateReplica(id, patch) {
    const current = await this.getReplica(id); if (!current) return null;
    if (patch.status) await this.assertTransition('replica', current, patch.status, assertReplicaTransition);
    const allowed = ['status', 'remote_id', 'remote_metadata_json', 'etag', 'checksum', 'size', 'last_checked_at', 'last_success_at', 'last_error_code', 'last_error_message'];
    const entries = Object.entries(patch).filter(([key]) => allowed.includes(key));
    if (!entries.length) return current;
    const sql = `UPDATE file_replicas SET ${entries.map(([key]) => `${key}=?`).join(',')}, updated_at=? WHERE id=?`;
    await this.db.prepare(sql).bind(...entries.map(([, value]) => value), now(), id).run(); return this.getReplica(id);
  }
  async updateFileStatus(id, status) {
    const current = await this.getFile(id);
    if (!current) return null;
    await this.assertTransition('file', current, status, assertFileTransition);
    await this.db.prepare('UPDATE files_v3 SET status=?, updated_at=? WHERE id=?').bind(status, now(), id).run();
    return this.getFile(id);
  }
  async createJob(job) {
    const time = now();
    await this.db.prepare(`INSERT OR IGNORE INTO storage_jobs
      (id,file_id,replica_id,channel_id,operation,generation,status,attempts,max_attempts,run_after,idempotency_key,payload_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(job.id, job.fileId, job.replicaId || null, job.channelId || null,
      job.operation, job.generation, job.status || 'pending', 0, job.maxAttempts || 5, job.runAfter || time,
      job.idempotencyKey, JSON.stringify(job.payload || {}), time, time).run();
    return first(this.db.prepare('SELECT * FROM storage_jobs WHERE idempotency_key=?').bind(job.idempotencyKey));
  }
  async getJob(id) { return first(this.db.prepare('SELECT * FROM storage_jobs WHERE id=?').bind(id)); }
  async claimJob(id, leaseMs = 60000) {
    const until = now() + leaseMs;
    const result = await this.db.prepare(`UPDATE storage_jobs SET status='running', attempts=attempts+1, lease_until=?, updated_at=?
      WHERE id=? AND status IN ('pending','queued','retry_wait') AND run_after <= ?`).bind(until, now(), id, now()).run();
    return result.meta?.changes ? this.getJob(id) : null;
  }
  async updateJob(id, status, patch = {}) {
    const current = await this.getJob(id);
    if (!current) return null;
    await this.assertTransition('job', current, status, assertJobTransition);
    await this.db.prepare(`UPDATE storage_jobs SET status=?, run_after=?, lease_until=?, last_error_code=?, last_error_message=?, completed_at=?, updated_at=? WHERE id=?`)
      .bind(status, patch.runAfter ?? now(), patch.leaseUntil ?? null, patch.errorCode ?? null, patch.errorMessage ?? null,
        ['succeeded', 'dead', 'cancelled'].includes(status) ? now() : null, now(), id).run();
    return this.getJob(id);
  }
  async dueJobs(limit = 50) { return all(this.db.prepare(`SELECT * FROM storage_jobs WHERE status IN ('pending','retry_wait','queued') AND run_after <= ? ORDER BY run_after LIMIT ?`).bind(now(), Math.min(limit, 50))); }
  async recoverExpiredLeases(limit = 50) {
    const expired = await all(this.db.prepare(`SELECT id FROM storage_jobs
      WHERE status='running' AND lease_until IS NOT NULL AND lease_until <= ? ORDER BY lease_until LIMIT ?`).bind(now(), Math.min(limit, 50)));
    for (const job of expired) {
      await this.db.prepare(`UPDATE storage_jobs SET status='retry_wait', lease_until=NULL, run_after=?, last_error_code='LEASE_EXPIRED', last_error_message='Worker lease expired before job completion', updated_at=?
        WHERE id=? AND status='running' AND lease_until <= ?`).bind(now(), now(), job.id, now()).run();
    }
    return expired.length;
  }
  async deferJobForGuard(id, level) {
    const current = await this.getJob(id);
    if (!current) return null;
    await this.assertTransition('job', current, 'retry_wait', assertJobTransition);
    // Paused work is not a failed attempt. It can resume when the daily guard resets.
    await this.db.prepare(`UPDATE storage_jobs SET status='retry_wait', attempts=CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
      lease_until=NULL, run_after=?, last_error_code='ZERO_COST_GUARD', last_error_message=?, updated_at=? WHERE id=?`)
      .bind(Date.now() + 15 * 60 * 1000, `Paused at protection level ${level || 'UNKNOWN'}`, now(), id).run();
    return this.getJob(id);
  }
  async createTombstone(fileId, expectedGeneration, actorId, reason) {
    const time = now();
    const generation = expectedGeneration + 1;
    await this.db.batch([
      this.db.prepare(`UPDATE files_v3 SET status='deleting', generation=?, updated_at=? WHERE id=? AND generation=? AND status NOT IN ('deleted','deleting')`).bind(generation, time, fileId, expectedGeneration),
      // Never replace an existing tombstone. A stale delete can only fill a missing
      // tombstone for the generation that is already marked deleting.
      this.db.prepare(`INSERT OR IGNORE INTO file_tombstones(file_id,generation,reason,created_by,created_at)
        SELECT id, generation, ?, ?, ? FROM files_v3
        WHERE id=? AND generation=? AND status='deleting'`).bind(reason || null, actorId || null, time, fileId, generation),
    ]);
    return first(this.db.prepare('SELECT * FROM file_tombstones WHERE file_id=?').bind(fileId));
  }
  async getTombstone(fileId) { return first(this.db.prepare('SELECT * FROM file_tombstones WHERE file_id=?').bind(fileId)); }
  async incrementUsage(day, changes) {
    const time = now(); const cols = Object.keys(changes); if (!cols.length) return this.getUsage(day);
    await this.db.prepare(`INSERT INTO usage_counters(day,${cols.join(',')},updated_at) VALUES(?,${cols.map(() => '?').join(',')},?)
      ON CONFLICT(day) DO UPDATE SET ${cols.map(key => `${key}=${key}+excluded.${key}`).join(',')},updated_at=excluded.updated_at`).bind(day, ...cols.map(key => changes[key]), time).run();
    return this.getUsage(day);
  }
  async getUsage(day) { return first(this.db.prepare('SELECT * FROM usage_counters WHERE day=?').bind(day)); }
  async setProtectionLevel(day, level) { await this.db.prepare('UPDATE usage_counters SET protection_level=?, updated_at=? WHERE day=?').bind(level, now(), day).run(); }
  async audit(entry) { await this.db.prepare('INSERT INTO audit_logs(id,actor_id,action,target_type,target_id,request_id,details_json,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(entry.id, entry.actorId || null, entry.action, entry.targetType, entry.targetId || null, entry.requestId || null, JSON.stringify(safeAuditDetails(entry.details || {})), now()).run(); }
  async assertTransition(entity, current, next, assertion) {
    try {
      assertion(current.status, next);
    } catch (error) {
      if (error.code !== 'INVALID_STATUS_TRANSITION') throw error;
      try {
        await this.audit({
          id: `audit_transition_${crypto.randomUUID()}`,
          action: 'state.transitionRejected',
          targetType: entity,
          targetId: current.id,
          details: { from: current.status, to: next, code: error.code },
        });
      } catch (auditError) {
        console.error('Failed to audit rejected state transition:', String(auditError?.message || 'unknown error').slice(0, 200));
      }
      console.warn(`Rejected ${entity} state transition: ${current.status} -> ${next}`);
      throw error;
    }
  }
  async listJobs({ limit, cursor, status, channelId, operation } = {}) {
    const p = page(limit, cursor); const clauses = ['rowid > ?']; const values = [p.cursor];
    if (status) { clauses.push('status=?'); values.push(status); } if (channelId) { clauses.push('channel_id=?'); values.push(channelId); } if (operation) { clauses.push('operation=?'); values.push(operation); }
    values.push(p.limit); return all(this.db.prepare(`SELECT rowid AS cursor, * FROM storage_jobs WHERE ${clauses.join(' AND ')} ORDER BY rowid LIMIT ?`).bind(...values));
  }
  async listAudits({ limit, cursor } = {}) {
    const p = page(limit, cursor);
    return all(this.db.prepare('SELECT rowid AS cursor, * FROM audit_logs WHERE rowid > ? ORDER BY rowid LIMIT ?').bind(p.cursor, p.limit));
  }
  async finalizeDeletion(fileId) {
    const replicas = await this.listReplicas(fileId);
    const file = await this.getFile(fileId);
    if (!file) return null;
    if (replicas.length > 0 && replicas.every(replica => replica.status === 'deleted')) {
      if (file.status !== 'deleted') await this.updateFileStatus(fileId, 'deleted');
      await this.db.prepare('UPDATE files_v3 SET deleted_at=?, updated_at=? WHERE id=?').bind(now(), now(), fileId).run();
      await this.db.prepare('UPDATE file_tombstones SET finalized_at=? WHERE file_id=?').bind(now(), fileId).run();
      return this.getFile(fileId);
    }
    return file;
  }
}

function safeAuditDetails(value) {
  if (Array.isArray(value)) return value.map(safeAuditDetails);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/authorization|cookie|token|secret|password|signature/i.test(key))
    .map(([key, item]) => [key, safeAuditDetails(item)]));
  return typeof value === 'string' ? value.replace(/(bearer|basic)\s+[^\s]+/gi, '$1 [redacted]').slice(0, 500) : value;
}
