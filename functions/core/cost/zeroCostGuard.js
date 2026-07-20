import { limitsFromEnv } from '../config.js';

const LEVELS = ['NORMAL', 'WARNING', 'WRITE_LIMITED', 'READ_ONLY', 'EMERGENCY'];
export function calculateProtectionLevel(usage = {}, limits) {
  const maxRatio = Math.max(
    (usage.worker_requests || 0) / limits.WORKER_REQUEST_SOFT_LIMIT,
    (usage.d1_reads || 0) / limits.D1_READ_SOFT_LIMIT,
    (usage.d1_writes || 0) / limits.D1_WRITE_SOFT_LIMIT,
    (usage.queue_operations || 0) / limits.QUEUE_OPS_SOFT_LIMIT,
    (usage.uploads || 0) / limits.DAILY_UPLOAD_SOFT_LIMIT,
  );
  if (maxRatio >= 1.2) return 'EMERGENCY'; if (maxRatio >= 1) return 'READ_ONLY'; if (maxRatio >= 0.9) return 'WRITE_LIMITED'; if (maxRatio >= 0.75) return 'WARNING'; return 'NORMAL';
}
export class ZeroCostGuard {
  constructor(repository, env, clock = () => new Date()) { this.repository = repository; this.env = env; this.clock = clock; this.limits = limitsFromEnv(env); }
  day() { return this.clock().toISOString().slice(0, 10); }
  async status() { const day = this.day(); const usage = await this.repository.getUsage(day) || { day }; const level = calculateProtectionLevel(usage, this.limits); if (usage.protection_level !== level) { await this.repository.incrementUsage(day, { worker_requests: 0 }); await this.repository.setProtectionLevel(day, level); } return { day, usage, level, limits: this.limits }; }
  async assertWrite({ admin = false, essential = false } = {}) { const { level } = await this.status(); if (level === 'EMERGENCY' || level === 'READ_ONLY') throw forbidden(level, 'Writes are disabled by the Zero-Cost Guard'); if (level === 'WRITE_LIMITED' && !admin && !essential) throw forbidden(level, 'Non-essential writes are disabled by the Zero-Cost Guard'); return level; }
  async assertDelete({ admin = true } = {}) {
    const { level } = await this.status();
    if (!admin) throw forbidden(level, 'Deletion requires an administrator');
    if (level === 'EMERGENCY') throw forbidden(level, 'Deletion is paused by the Zero-Cost Guard');
    // Tombstone-first deletion is a safety operation, including in read-only mode.
    return level;
  }
  async assertRepair({ critical = false } = {}) {
    const { level } = await this.status();
    if (['EMERGENCY', 'READ_ONLY'].includes(level)) throw forbidden(level, 'Replica repair is paused by the Zero-Cost Guard');
    if (level === 'WRITE_LIMITED' && !critical) throw forbidden(level, 'Non-critical replica repair is paused by the Zero-Cost Guard');
    return level;
  }
  async assertVerify() {
    const { level } = await this.status();
    if (level !== 'NORMAL') throw forbidden(level, 'Replica verification is paused by the Zero-Cost Guard');
    return level;
  }
  async assertAsyncReplica() {
    const { level } = await this.status();
    if (level !== 'NORMAL') throw forbidden(level, 'Asynchronous replicas are paused by the Zero-Cost Guard');
    return level;
  }
  async assertQueue({ essential = false } = {}) { const { level } = await this.status(); if (level === 'EMERGENCY' || (level === 'READ_ONLY' && !essential) || (level === 'WRITE_LIMITED' && !essential)) throw forbidden(level, 'Queue dispatch is paused by the Zero-Cost Guard'); return level; }
  async record(changes) { return this.repository.incrementUsage(this.day(), changes); }
}
function forbidden(level, message) { const error = new Error(message); error.code = 'ZERO_COST_GUARD'; error.level = level; return error; }
export { LEVELS };
