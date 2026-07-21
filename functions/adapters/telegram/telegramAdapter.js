import { StorageAdapter, StorageError, STORAGE_ERROR_CODES, errorForResponse, withTimeout } from '../../core/storage/adapter.js';
import { assertExternalEndpoint } from '../../core/security/endpointValidation.js';

const TELEGRAM_BOT_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

export class TelegramAdapter extends StorageAdapter {
  provider() { return 'telegram'; }
  capabilities() { return { ...super.capabilities(), head: true, range: true, maxObjectSize: TELEGRAM_BOT_DOWNLOAD_LIMIT }; }
  config() { return this.channel.config || {}; }
  token() { return this.env?.[this.channel.secretRefs?.tokenRef] || this.env?.[this.channel.secret_refs?.tokenRef]; }
  baseUrl() { const value = this.config().proxyUrl || 'https://api.telegram.org'; try { const url = assertExternalEndpoint(value, { label: 'Telegram proxyUrl' }); return url.toString().replace(/\/$/, ''); } catch (error) { throw new StorageError({ provider: this.provider(), channelId: this.channel.id, code: STORAGE_ERROR_CODES.INVALID_CONFIGURATION, message: error.message }); } }
  endpoint(path) { return `${this.baseUrl()}/bot${this.token()}/${path}`; }
  fileEndpoint(path) { return `${this.baseUrl()}/file/bot${this.token()}/${path}`; }
  ensureConfig() { if (!this.token() || !this.config().chatId) throw new StorageError({ provider: this.provider(), channelId: this.channel.id, code: STORAGE_ERROR_CODES.INVALID_CONFIGURATION, message: 'Telegram token secret reference and chatId are required' }); }
  async api(path, init, operation) { this.ensureConfig(); const response = await withTimeout(this.fetch, this.endpoint(path), { ...init, redirect: 'manual' }, Number(this.config().timeoutMs) || 10000, { provider: this.provider(), channelId: this.channel.id }); if (response.status >= 300 && response.status < 400) throw new StorageError({ provider: this.provider(), channelId: this.channel.id, code: STORAGE_ERROR_CODES.INVALID_CONFIGURATION, message: 'Telegram redirects are not allowed' }); if (!response.ok) throw errorForResponse(this.provider(), this.channel.id, response, operation); const data = await response.json(); if (!data.ok) throw telegramError(this.channel.id, operation, data, response.status); return data.result; }
  async put(input) {
    this.ensureConfig(); if (input.size > TELEGRAM_BOT_DOWNLOAD_LIMIT) throw new StorageError({ provider: this.provider(), channelId: this.channel.id, code: STORAGE_ERROR_CODES.FILE_TOO_LARGE, message: 'Telegram Bot API download limit is 20 MiB' });
    const form = new FormData(); form.append('chat_id', this.config().chatId); form.append('document', input.body, input.name || input.objectKey.split('/').pop() || 'file');
    const result = await this.api('sendDocument', { method: 'POST', body: form }, 'sendDocument'); const document = result.document || result.video || result.audio || result.photo?.at(-1);
    if (!document?.file_id) throw new StorageError({ provider: this.provider(), channelId: this.channel.id, code: STORAGE_ERROR_CODES.UNKNOWN, message: 'Telegram response did not contain file_id' });
    return { objectKey: input.objectKey, remoteId: document.file_id, etag: document.file_unique_id || null, checksum: null, size: document.file_size || input.size, safeMetadata: { messageId: String(result.message_id), fileUniqueId: document.file_unique_id || null } };
  }
  async fileInfo(remoteId) { return this.api(`getFile?file_id=${encodeURIComponent(remoteId)}`, { method: 'GET' }, 'getFile'); }
  async get(input) { const info = await this.fileInfo(input.remoteId); const response = await withTimeout(this.fetch, this.fileEndpoint(info.file_path), { method: 'GET', headers: input.range ? { Range: input.range } : {}, redirect: 'manual' }, Number(this.config().timeoutMs) || 10000, { provider: this.provider(), channelId: this.channel.id }); if (response.status >= 300 && response.status < 400) throw new StorageError({ provider: this.provider(), channelId: this.channel.id, code: STORAGE_ERROR_CODES.INVALID_CONFIGURATION, message: 'Telegram redirects are not allowed' }); if (!response.ok) throw errorForResponse(this.provider(), this.channel.id, response, 'GET'); return response; }
  async head(input) { const info = await this.fileInfo(input.remoteId); return { exists: true, size: info.file_size || null, etag: info.file_unique_id || null, checksum: null }; }
  async delete(input) { const messageId = input.safeMetadata?.messageId || input.messageId; if (!messageId) throw new StorageError({ provider: this.provider(), channelId: this.channel.id, code: STORAGE_ERROR_CODES.UNSUPPORTED, message: 'Telegram deletion requires a stored messageId' }); try { await this.api(`deleteMessage?chat_id=${encodeURIComponent(this.config().chatId)}&message_id=${encodeURIComponent(messageId)}`, { method: 'POST' }, 'deleteMessage'); } catch (error) { if (error.code !== STORAGE_ERROR_CODES.NOT_FOUND) throw error; } return { deleted: true }; }
  async healthCheck() { const result = await this.api('getMe', { method: 'GET' }, 'getMe'); return { healthy: true, username: result.username || null }; }
}

function telegramError(channelId, operation, data, status) {
  const description = String(data.description || `Telegram ${operation} failed`); const parameters = data.parameters || {};
  if (status === 429 || parameters.retry_after) return new StorageError({ provider: 'telegram', channelId, code: STORAGE_ERROR_CODES.RATE_LIMITED, retryable: true, status, retryAfterSeconds: parameters.retry_after || null, message: 'Telegram rate limited' });
  if (/message to delete not found|message_id_invalid|file not found|not found/i.test(description)) return new StorageError({ provider: 'telegram', channelId, code: STORAGE_ERROR_CODES.NOT_FOUND, retryable: false, status, message: `Telegram ${operation} object not found` });
  if (/unauthorized|forbidden|not enough rights/i.test(description)) return new StorageError({ provider: 'telegram', channelId, code: STORAGE_ERROR_CODES.AUTH_FAILED, retryable: false, status, message: 'Telegram authorization failed' });
  return new StorageError({ provider: 'telegram', channelId, code: status >= 500 ? STORAGE_ERROR_CODES.NETWORK_ERROR : STORAGE_ERROR_CODES.UNKNOWN, retryable: status >= 500, status, message: `Telegram ${operation} failed` });
}
