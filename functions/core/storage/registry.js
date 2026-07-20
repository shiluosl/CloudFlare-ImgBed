import { r2Allowed } from '../config.js';
import { StorageError, STORAGE_ERROR_CODES } from './adapter.js';
import { WebDavAdapter } from '../../adapters/webdav/webdavAdapter.js';
import { TelegramAdapter } from '../../adapters/telegram/telegramAdapter.js';

const factories = Object.freeze({ webdav: (channel, env, fetchImpl) => new WebDavAdapter(channel, env, fetchImpl), telegram: (channel, env, fetchImpl) => new TelegramAdapter(channel, env, fetchImpl) });

export function getAdapter(channel, env, fetchImpl) {
  if (!channel?.provider) throw new StorageError({ provider: 'unknown', channelId: channel?.id, code: STORAGE_ERROR_CODES.INVALID_CONFIGURATION, message: 'Storage channel provider is required' });
  if (channel.provider === 'r2' && !r2Allowed(env)) throw new StorageError({ provider: 'r2', channelId: channel.id, code: STORAGE_ERROR_CODES.UNSUPPORTED, message: 'R2 is disabled by Zero-Cost mode' });
  const factory = factories[channel.provider];
  if (!factory) throw new StorageError({ provider: channel.provider, channelId: channel.id, code: STORAGE_ERROR_CODES.UNSUPPORTED, message: `Unsupported storage provider: ${channel.provider}` });
  return factory(channel, env, fetchImpl);
}

export const supportedProviders = () => Object.keys(factories);
