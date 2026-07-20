import { getAdapter } from '../storage/registry.js';

export class ChannelHealthService {
  constructor(repository, env) { this.repository = repository; this.env = env; }

  async check(channelId) {
    const channel = await this.repository.getChannel(channelId);
    if (!channel) return null;
    if (!channel.enabled) return this.repository.setChannelHealth(channelId, 'disabled');
    try {
      const adapter = getAdapter(normalize(channel), this.env);
      const result = await adapter.healthCheck();
      if (result?.healthy === false) throw Object.assign(new Error('Channel health check was not successful'), { code: 'HEALTH_CHECK_FAILED' });
      return this.recordSuccess(channel);
    } catch (error) {
      return this.recordFailure(channel, error);
    }
  }

  async recordSuccess(channel) {
    if (!channel?.id && channel?.channel_id) channel = await this.repository.getChannel(channel.channel_id);
    if (!channel) return null;
    const successes = Number(channel.consecutive_successes || 0) + 1;
    return this.repository.setChannelHealth(channel.id, successes >= 2 ? 'healthy' : 'unknown', {
      consecutiveFailures: 0,
      consecutiveSuccesses: successes,
      blockedUntil: null,
      lastSuccessAt: Date.now(),
      errorCode: null,
      errorMessage: null,
    });
  }

  async recordFailure(channel, error) {
    if (!channel?.id && channel?.channel_id) channel = await this.repository.getChannel(channel.channel_id);
    if (!channel) return null;
    const code = error.code || 'UNKNOWN';
    const failures = Number(channel.consecutive_failures || 0) + 1;
    let status = failures >= 5 ? 'offline' : failures >= 3 ? 'degraded' : channel.health_status || 'unknown';
    if (code === 'AUTH_FAILED') status = 'offline';
    if (code === 'QUOTA_EXCEEDED') status = 'quota_blocked';
    const retryAfterSeconds = Number(error.retryAfterSeconds);
    const blockedUntil = code === 'RATE_LIMITED' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? Date.now() + retryAfterSeconds * 1000
      : null;
    return this.repository.setChannelHealth(channel.id, status, {
      consecutiveFailures: failures,
      consecutiveSuccesses: 0,
      blockedUntil,
      lastFailureAt: Date.now(),
      errorCode: code,
      errorMessage: safeMessage(error),
    });
  }
}

function normalize(channel) { return { ...channel, config: parse(channel.config_json), secretRefs: parse(channel.secret_refs_json) }; }
function parse(value) { try { return JSON.parse(value || '{}'); } catch { return {}; } }
function safeMessage(error) { return String(error?.message || 'Channel health check failed').replace(/(bearer|basic)\s+[^\s]+/gi, '$1 [redacted]').slice(0, 500); }
