import { StorageAdapter, StorageError, STORAGE_ERROR_CODES, errorForResponse, withTimeout } from '../../core/storage/adapter.js';
import { buildWebDAVUrl, normalizeBaseUrl } from '../../utils/storage/webdavAPI.js';
import { assertExternalEndpoint } from '../../core/security/endpointValidation.js';

export class WebDavAdapter extends StorageAdapter {
  provider() { return 'webdav'; }
  capabilities() { return { ...super.capabilities(), range: true, maxObjectSize: null }; }
  config() { return this.channel.config || {}; }
  headers(extra = {}) {
    const config = this.config(); const headers = new Headers(config.headers || {});
    if (headers.has('Authorization')) throw new StorageError({ provider: this.provider(), channelId: this.channel.id, code: STORAGE_ERROR_CODES.INVALID_CONFIGURATION, message: 'WebDAV Authorization must be provided through secret references' });
    const username = this.env?.[this.channel.secret_refs?.usernameRef] || this.env?.[this.channel.secretRefs?.usernameRef];
    const password = this.env?.[this.channel.secret_refs?.passwordRef] || this.env?.[this.channel.secretRefs?.passwordRef];
    if (!headers.has('Authorization') && (username || password)) headers.set('Authorization', `Basic ${base64(`${username || ''}:${password || ''}`)}`);
    for (const [key, value] of Object.entries(extra)) if (value !== undefined && value !== null) headers.set(key, value);
    return headers;
  }
  objectUrl(key) { try { const config = this.config(); assertExternalEndpoint(config.baseUrl, { allowPrivate: config.allowPrivateEndpoint === true, label: 'WebDAV baseUrl' }); return buildWebDAVUrl(normalizeBaseUrl(config.baseUrl), key); } catch (error) { throw new StorageError({ provider: this.provider(), channelId: this.channel.id, code: STORAGE_ERROR_CODES.INVALID_CONFIGURATION, message: error.message }); } }
  async request(key, init, operation) {
    const response = await withTimeout(this.fetch, this.objectUrl(key), { ...init, headers: this.headers(init.headers), redirect: 'manual' }, Number(this.config().timeoutMs) || 10000, { provider: this.provider(), channelId: this.channel.id });
    if (response.status >= 300 && response.status < 400) throw new StorageError({ provider: this.provider(), channelId: this.channel.id, code: STORAGE_ERROR_CODES.INVALID_CONFIGURATION, message: 'WebDAV redirects are not allowed' });
    if (!response.ok) throw errorForResponse(this.provider(), this.channel.id, response, operation); return response;
  }
  async ensureDirectory(key) { if (this.config().createDirectory === false) return; const parts = String(key).split('/').filter(Boolean); parts.pop(); let path = ''; for (const part of parts) { path = path ? `${path}/${part}` : part; const response = await withTimeout(this.fetch, this.objectUrl(path), { method: 'MKCOL', headers: this.headers(), redirect: 'manual' }, Number(this.config().timeoutMs) || 10000, { provider: this.provider(), channelId: this.channel.id }); if (response.status >= 300 && response.status < 400) throw new StorageError({ provider: this.provider(), channelId: this.channel.id, code: STORAGE_ERROR_CODES.INVALID_CONFIGURATION, message: 'WebDAV redirects are not allowed' }); if (![200, 201, 204, 405].includes(response.status)) throw errorForResponse(this.provider(), this.channel.id, response, 'MKCOL'); } }
  async put(input) { await this.ensureDirectory(input.objectKey); const response = await this.request(input.objectKey, { method: 'PUT', body: input.body, headers: { 'Content-Type': input.contentType || 'application/octet-stream' } }, 'PUT'); return { objectKey: input.objectKey, remoteId: null, etag: response.headers.get('ETag'), checksum: null, size: input.size, safeMetadata: {} }; }
  async get(input) { return this.request(input.objectKey, { method: 'GET', headers: input.range ? { Range: input.range } : {} }, 'GET'); }
  async head(input) { const response = await this.request(input.objectKey, { method: 'HEAD' }, 'HEAD'); return { exists: true, size: Number(response.headers.get('Content-Length')) || null, etag: response.headers.get('ETag'), checksum: response.headers.get('Digest') || null }; }
  async delete(input) { try { await this.request(input.objectKey, { method: 'DELETE' }, 'DELETE'); } catch (error) { if (error.code !== STORAGE_ERROR_CODES.NOT_FOUND) throw error; } return { deleted: true }; }
  async healthCheck() { const response = await withTimeout(this.fetch, this.objectUrl(''), { method: 'OPTIONS', headers: this.headers(), redirect: 'manual' }, Number(this.config().timeoutMs) || 5000, { provider: this.provider(), channelId: this.channel.id }); if (response.status === 401 || response.status === 403) throw errorForResponse(this.provider(), this.channel.id, response, 'healthCheck'); return { healthy: response.ok || response.status === 405, status: response.status }; }
}
function base64(value) { const bytes = new TextEncoder().encode(value); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return typeof btoa === 'function' ? btoa(binary) : Buffer.from(value).toString('base64'); }
