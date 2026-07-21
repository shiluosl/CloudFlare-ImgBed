import { zeroCostEnabled } from '../config.js';

export function isLegacyR2ChannelForbidden(env = {}, channel) {
  return zeroCostEnabled(env) && String(channel || '').toLowerCase() === 'cfr2';
}

export function emptyLegacyR2Config() {
  return {
    channels: [],
    loadBalance: {
      enabled: false,
      channels: [],
    },
  };
}

export function hasLegacyR2Configuration(settings = {}) {
  const config = settings?.cfr2;
  if (!config || typeof config !== 'object') return false;
  const allowedKeys = new Set(['channels', 'loadBalance']);
  if (Object.keys(config).some(key => !allowedKeys.has(key))) return true;
  const channels = Array.isArray(config.channels) ? config.channels : [];
  const loadBalance = config.loadBalance && typeof config.loadBalance === 'object'
    ? config.loadBalance
    : {};
  const balancedChannels = Array.isArray(loadBalance.channels) ? loadBalance.channels : [];

  return channels.length > 0 || loadBalance.enabled === true || balancedChannels.length > 0 ||
    Object.keys(loadBalance).some(key => key !== 'enabled' && key !== 'channels');
}

export function hasLegacyR2DefaultSelection(settings = {}) {
  return Array.isArray(settings?.config) && settings.config.some(item =>
    item?.id === 'defaultUploadChannel' && String(item.value || '').toLowerCase() === 'cfr2',
  );
}
