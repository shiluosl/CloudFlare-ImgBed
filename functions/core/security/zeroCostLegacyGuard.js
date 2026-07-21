import { zeroCostEnabled } from '../config.js';

export function isLegacyR2ChannelForbidden(env = {}, channel) {
  return zeroCostEnabled(env) && String(channel || '').toLowerCase() === 'cfr2';
}
