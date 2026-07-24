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
  async api(path, init, operation) {
    this.ensureConfig();
    const response = await withTimeout(this.fetch, this.endpoint(path), { ...init, redirect: 'manual' }, Number(this.config().timeoutMs) || 10000, { provider: this.provider(), channelId: this.channel.id });
    if (response.status >= 300 && response.status < 400) throw new StorageError({ provider: this.provider(), channelId: this.channel.id, code: STORAGE_ERROR_CODES.INVALID_CONFIGURATION, message: 'Telegram redirects are not allowed' });
    const data = await response.json().catch(() => null);
    if (data?.ok === false) throw telegramError(this.channel.id, operation, data, response.status);
    if (!response.ok) throw errorForResponse(this.provider(), this.channel.id, response, operation);
    if (!data?.ok) throw new StorageError({ provider: this.provider(), channelId: this.channel.id, code: STORAGE_ERROR_CODES.UNKNOWN, message: `Telegram ${operation} returned an invalid response` });
    return data.result;
  }
  async put(input) {
    this.ensureConfig(); if (input.size > TELEGRAM_BOT_DOWNLOAD_LIMIT) throw new StorageError({ provider: this.provider(), channelId: this.channel.id, code: STORAGE_ERROR_CODES.FILE_TOO_LARGE, message: 'Telegram Bot API download limit is 20 MiB' });
    const multipart = documentMultipartBody(this.config().chatId, input.body, input.name || input.objectKey.split('/').pop() || 'file', input.contentType || 'application/octet-stream');
    const result = await this.api('sendDocument', { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${multipart.boundary}` }, body: multipart.body }, 'sendDocument'); const document = result.document || result.video || result.audio || result.photo?.at(-1);
    if (!document?.file_id) throw new StorageError({ provider: this.provider(), channelId: this.channel.id, code: STORAGE_ERROR_CODES.UNKNOWN, message: 'Telegram response did not contain file_id' });
    return { objectKey: input.objectKey, remoteId: document.file_id, etag: document.file_unique_id || null, checksum: null, size: document.file_size || input.size, safeMetadata: { messageId: String(result.message_id), fileUniqueId: document.file_unique_id || null } };
  }
  async fileInfo(remoteId) { return this.api(`getFile?file_id=${encodeURIComponent(remoteId)}`, { method: 'GET' }, 'getFile'); }
  async get(input) { const info = await this.fileInfo(input.remoteId); const response = await withTimeout(this.fetch, this.fileEndpoint(info.file_path), { method: 'GET', headers: input.range ? { Range: input.range } : {}, redirect: 'manual' }, Number(this.config().timeoutMs) || 10000, { provider: this.provider(), channelId: this.channel.id }); if (response.status >= 300 && response.status < 400) throw new StorageError({ provider: this.provider(), channelId: this.channel.id, code: STORAGE_ERROR_CODES.INVALID_CONFIGURATION, message: 'Telegram redirects are not allowed' }); if (!response.ok) throw errorForResponse(this.provider(), this.channel.id, response, 'GET'); return response; }
  async head(input) { const info = await this.fileInfo(input.remoteId); return { exists: true, size: info.file_size || null, etag: info.file_unique_id || null, checksum: null }; }
  async delete(input) {
    const messageId = input.safeMetadata?.messageId || input.messageId;
    // A failed sendDocument never produces a managed remote identity. Telegram
    // has no safe, bounded lookup for an unknown historical message, so this is
    // idempotently equivalent to deleting an already absent replica.
    if (!messageId) return { deleted: true, alreadyAbsent: true };
    try { await this.api(`deleteMessage?chat_id=${encodeURIComponent(this.config().chatId)}&message_id=${encodeURIComponent(messageId)}`, { method: 'POST' }, 'deleteMessage'); } catch (error) { if (error.code !== STORAGE_ERROR_CODES.NOT_FOUND) throw error; } return { deleted: true };
  }
  async healthCheck() {
    const bot = await this.api('getMe', { method: 'GET' }, 'getMe');
    if (!bot?.id) throw new StorageError({ provider: this.provider(), channelId: this.channel.id, code: STORAGE_ERROR_CODES.AUTH_FAILED, message: 'Telegram bot identity is unavailable' });
    const [chat, membership] = await Promise.all([
      this.api(`getChat?chat_id=${encodeURIComponent(this.config().chatId)}`, { method: 'GET' }, 'getChat'),
      this.api(`getChatMember?chat_id=${encodeURIComponent(this.config().chatId)}&user_id=${encodeURIComponent(bot.id)}`, { method: 'GET' }, 'getChatMember'),
    ]);
    assertCanPost(this.channel.id, chat, membership);
    return { healthy: true, username: bot.username || null, chatType: chat?.type || null };
  }
}

function assertCanPost(channelId, chat, membership) {
  const status = membership?.status;
  const chatType = chat?.type;
  const isAdministrator = ['creator', 'administrator'].includes(status);
  const prohibited = membership?.can_send_messages === false || membership?.can_post_messages === false;
  const channelWithoutAdmin = chatType === 'channel' && !isAdministrator;
  if (!status || ['left', 'kicked', 'restricted'].includes(status) || prohibited || channelWithoutAdmin) {
    throw new StorageError({ provider: 'telegram', channelId, code: STORAGE_ERROR_CODES.AUTH_FAILED, retryable: false, message: 'Telegram bot cannot post to the configured chat' });
  }
}

function telegramError(channelId, operation, data, status) {
  const description = String(data.description || `Telegram ${operation} failed`); const parameters = data.parameters || {};
  if (status === 429 || parameters.retry_after) return new StorageError({ provider: 'telegram', channelId, code: STORAGE_ERROR_CODES.RATE_LIMITED, retryable: true, status, retryAfterSeconds: parameters.retry_after || null, message: 'Telegram rate limited' });
  if (/unauthorized|forbidden|not enough rights|chat not found|bot was kicked|user not found/i.test(description)) return new StorageError({ provider: 'telegram', channelId, code: STORAGE_ERROR_CODES.AUTH_FAILED, retryable: false, status, message: 'Telegram authorization failed' });
  if (/message to delete not found|message_id_invalid|file not found|not found/i.test(description)) return new StorageError({ provider: 'telegram', channelId, code: STORAGE_ERROR_CODES.NOT_FOUND, retryable: false, status, message: `Telegram ${operation} object not found` });
  return new StorageError({ provider: 'telegram', channelId, code: status >= 500 ? STORAGE_ERROR_CODES.NETWORK_ERROR : STORAGE_ERROR_CODES.UNKNOWN, retryable: status >= 500, status, message: `Telegram ${operation} failed` });
}

function documentMultipartBody(chatId, source, filename, contentType) {
  const boundary = `----imgbed-${crypto.randomUUID().replace(/-/g, '')}`;
  const encoder = new TextEncoder();
  const safeFilename = String(filename || 'file').replace(/[\r\n"]/g, '_');
  const content = toReadableStream(source);
  const prefix = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${safeFilename}"\r\nContent-Type: ${contentType}\r\n\r\n`);
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const reader = content.getReader();
  let stage = 0;
  return {
    boundary,
    body: new ReadableStream({
      async pull(controller) {
        if (stage === 0) { stage = 1; controller.enqueue(prefix); return; }
        if (stage === 1) {
          const { done, value } = await reader.read();
          if (!done) { controller.enqueue(value); return; }
          stage = 2;
        }
        if (stage === 2) { stage = 3; controller.enqueue(suffix); controller.close(); }
      },
      async cancel(reason) { await reader.cancel(reason); },
    }),
  };
}

function toReadableStream(value) {
  if (value?.getReader) return value;
  if (value?.stream) return value.stream();
  return new Blob([value ?? '']).stream();
}
