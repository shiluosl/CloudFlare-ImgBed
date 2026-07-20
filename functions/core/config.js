export const DEFAULT_LIMITS = Object.freeze({
  WORKER_REQUEST_SOFT_LIMIT: 80000,
  D1_READ_SOFT_LIMIT: 3000000,
  D1_WRITE_SOFT_LIMIT: 60000,
  QUEUE_OPS_SOFT_LIMIT: 7000,
  DAILY_UPLOAD_SOFT_LIMIT: 500,
  MAX_UPLOAD_BYTES: 10485760,
  HARD_MAX_UPLOAD_BYTES: 20971520,
  MAX_SYNC_CHANNELS: 2,
});

export function isEnabled(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return String(value).toLowerCase() === 'true';
}

export function limitsFromEnv(env = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([key, fallback]) => {
    const value = Number(env[key]);
    return [key, Number.isFinite(value) && value > 0 ? value : fallback];
  }));
}

export function zeroCostEnabled(env = {}) { return isEnabled(env.ZERO_COST_MODE, true); }
export function r2Allowed(env = {}) { return !zeroCostEnabled(env) && isEnabled(env.ALLOW_R2, false); }
export function v3Enabled(env = {}) { return isEnabled(env.ENABLE_REPLICATION_V3, true); }
