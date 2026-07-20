export const STORAGE_ERROR_CODES = Object.freeze({
  AUTH_FAILED: 'AUTH_FAILED', NOT_FOUND: 'NOT_FOUND', RATE_LIMITED: 'RATE_LIMITED', TIMEOUT: 'TIMEOUT',
  NETWORK_ERROR: 'NETWORK_ERROR', QUOTA_EXCEEDED: 'QUOTA_EXCEEDED', FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  CHECKSUM_MISMATCH: 'CHECKSUM_MISMATCH', PERMISSION_DENIED: 'PERMISSION_DENIED', INVALID_CONFIGURATION: 'INVALID_CONFIGURATION',
  UNSUPPORTED: 'UNSUPPORTED', REMOTE_CONFLICT: 'REMOTE_CONFLICT', UNKNOWN: 'UNKNOWN',
});

export class StorageError extends Error {
  constructor({ provider, channelId, code = STORAGE_ERROR_CODES.UNKNOWN, retryable = false, message, status = null, retryAfterSeconds = null, cause = null }) {
    super(message || code); this.name = 'StorageError'; this.provider = provider; this.channelId = channelId;
    this.code = code; this.retryable = retryable; this.status = status; this.retryAfterSeconds = retryAfterSeconds; this.cause = cause;
  }
}

export class StorageAdapter {
  constructor(channel, env, fetchImpl = fetch) { this.channel = channel; this.env = env; this.fetch = fetchImpl; }
  provider() { throw new Error('Not implemented'); }
  capabilities() { return { read: true, write: true, delete: true, head: true, range: false, checksum: false, maxObjectSize: null }; }
  async put() { throw new Error('Not implemented'); }
  async get() { throw new Error('Not implemented'); }
  async head() { throw new Error('Not implemented'); }
  async delete() { throw new Error('Not implemented'); }
  async healthCheck() { throw new Error('Not implemented'); }
}

export function errorForResponse(provider, channelId, response, operation) {
  const status = response.status; const retryAfter = Number(response.headers?.get?.('Retry-After')) || null;
  if (status === 401 || status === 403) return new StorageError({ provider, channelId, code: STORAGE_ERROR_CODES.AUTH_FAILED, retryable: false, status, message: `${provider} ${operation} authorization failed` });
  if (status === 404) return new StorageError({ provider, channelId, code: STORAGE_ERROR_CODES.NOT_FOUND, retryable: false, status, message: `${provider} ${operation} object not found` });
  if (status === 413) return new StorageError({ provider, channelId, code: STORAGE_ERROR_CODES.FILE_TOO_LARGE, retryable: false, status, message: `${provider} ${operation} file too large` });
  if (status === 429) return new StorageError({ provider, channelId, code: STORAGE_ERROR_CODES.RATE_LIMITED, retryable: true, status, retryAfterSeconds: retryAfter, message: `${provider} ${operation} rate limited` });
  if (status >= 500) return new StorageError({ provider, channelId, code: STORAGE_ERROR_CODES.NETWORK_ERROR, retryable: true, status, message: `${provider} ${operation} remote failure` });
  return new StorageError({ provider, channelId, retryable: false, status, message: `${provider} ${operation} failed with ${status}` });
}

export function withTimeout(fetchImpl, url, init, timeoutMs = 10000, detail = {}) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetchImpl(url, { ...init, signal: controller.signal }).catch(error => {
    if (error?.name === 'AbortError') throw new StorageError({ ...detail, code: STORAGE_ERROR_CODES.TIMEOUT, retryable: true, message: `${detail.provider} request timed out`, cause: error });
    if (error instanceof StorageError) throw error;
    throw new StorageError({ ...detail, code: STORAGE_ERROR_CODES.NETWORK_ERROR, retryable: true, message: `${detail.provider} network request failed`, cause: error });
  }).finally(() => clearTimeout(timer));
}

export function safeError(error) {
  if (error instanceof StorageError) return error;
  return new StorageError({ provider: 'unknown', code: STORAGE_ERROR_CODES.UNKNOWN, retryable: false, message: error?.message || 'Storage operation failed', cause: error });
}
