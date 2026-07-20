import { getAdapter } from './registry.js';

export class StorageOrchestrator {
  constructor(repository, env, jobService = null, healthService = null) { this.repository = repository; this.env = env; this.jobService = jobService; this.healthService = healthService; }
  async channelsForPolicy(policy) {
    const ids = [policy.primary_channel_id, policy.sync_backup_channel_id, ...JSON.parse(policy.async_channels_json || '[]')].filter(Boolean);
    const channels = await Promise.all(ids.map(id => this.repository.getChannel(id))); return channels.filter(Boolean);
  }
  async writeReplica(file, replica, channel, input) {
    try { const adapter = getAdapter(normalizeChannel(channel), this.env); await this.repository.updateReplica(replica.id, { status: 'uploading' }); const stored = await adapter.put({ ...input, fileId: file.id, objectKey: replica.object_key, generation: file.generation }); await this.repository.updateReplica(replica.id, { status: 'healthy', remote_id: stored.remoteId, remote_metadata_json: JSON.stringify(stored.safeMetadata || {}), etag: stored.etag, checksum: stored.checksum, size: stored.size, last_success_at: Date.now(), last_error_code: null, last_error_message: null }); await this.healthService?.recordSuccess(channel); return { replica: await this.repository.getReplica(replica.id), stored }; }
    catch (error) { await this.repository.updateReplica(replica.id, { status: 'retry_wait', last_error_code: error.code || 'UNKNOWN', last_error_message: safeErrorMessage(error) }); await this.healthService?.recordFailure(channel, error); return { replica: await this.repository.getReplica(replica.id), error }; }
  }
  async recomputeFileHealth(fileId) {
    const file = await this.repository.getFile(fileId); const replicas = await this.repository.listReplicas(fileId); const healthy = replicas.filter(replica => replica.status === 'healthy').length;
    let status = healthy >= 2 ? 'available' : healthy === 1 ? 'degraded' : 'failed'; if (file.status === 'deleting' || file.status === 'deleted') return file;
    return this.repository.updateFileStatus(fileId, status);
  }
  async readCandidates(fileId) {
    const replicas = await this.repository.listReplicas(fileId);
    const time = Date.now();
    return replicas.filter(replica => ['healthy', 'suspect'].includes(replica.status) && replica.enabled && !['offline', 'disabled', 'quota_blocked'].includes(replica.health_status) && (!replica.blocked_until || Number(replica.blocked_until) <= time))
      .sort((a, b) => score(b) - score(a)).slice(0, 2);
  }
  async openReplica(replica, range) { const channel = await this.repository.getChannel(replica.channel_id); return getAdapter(normalizeChannel(channel), this.env).get({ objectKey: replica.object_key, remoteId: replica.remote_id, safeMetadata: JSON.parse(replica.remote_metadata_json || '{}'), range }); }
}
function score(replica) { return (replica.role === 'primary' ? 1000 : 0) + (replica.health_status === 'healthy' ? 100 : 0) - (replica.priority || 100); }
function normalizeChannel(channel) { return { ...channel, config: JSON.parse(channel.config_json || '{}'), secretRefs: JSON.parse(channel.secret_refs_json || '{}') }; }
function safeErrorMessage(error) { return String(error?.message || 'Storage write failed').replace(/(bearer|basic)\s+[^\s]+/gi, '$1 [redacted]').slice(0, 500); }
