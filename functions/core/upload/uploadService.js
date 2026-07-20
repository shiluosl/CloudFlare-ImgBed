import { StorageOrchestrator } from '../storage/orchestrator.js';

export class UploadService {
  constructor(repository, guard, env, jobService) { this.repository = repository; this.guard = guard; this.env = env; this.jobService = jobService; this.orchestrator = new StorageOrchestrator(repository, env, jobService); }
  async upload(input) {
    await this.guard.assertWrite({ admin: input.admin }); await this.validate(input);
    const prior = await this.repository.getFileByIdempotency(input.idempotencyKey); if (prior) return { file: prior, idempotent: true, replicas: await this.repository.listReplicas(prior.id) };
    const policy = await this.repository.getPolicy(input.policyId); if (!policy?.enabled) throw new Error('Storage policy is unavailable');
    const channelIds = [policy.primary_channel_id, policy.sync_backup_channel_id].filter(Boolean); if (channelIds.length > this.guard.limits.MAX_SYNC_CHANNELS) throw new Error(`Zero-Cost mode allows at most ${this.guard.limits.MAX_SYNC_CHANNELS} synchronous channels`);
    if (channelIds.length < 1) throw new Error('Storage policy needs a primary channel');
    const level = this.guard.status ? (await this.guard.status()).level : 'NORMAL';
    const asyncChannelIds = level === 'NORMAL' ? JSON.parse(policy.async_channels_json || '[]').filter(id => !channelIds.includes(id)) : [];
    const fileId = input.id || `file_${crypto.randomUUID()}`;
    const replicaSpecs = [
      ...channelIds.map((channelId, index) => ({ id: `rep_${crypto.randomUUID()}`, channelId, role: index === 0 ? 'primary' : 'sync_backup', objectKey: `${fileId}/${safeName(input.name)}` })),
      ...asyncChannelIds.map(channelId => ({ id: `rep_${crypto.randomUUID()}`, channelId, role: 'async_backup', objectKey: `${fileId}/${safeName(input.name)}` })),
    ];
    const file = await this.repository.createFileWithReplicas({ id: fileId, idempotencyKey: input.idempotencyKey, ownerId: input.ownerId, policyId: policy.id, name: safeName(input.name), contentType: input.contentType, size: input.size, isPublic: input.isPublic, status: 'receiving' }, replicaSpecs);
    const replicas = await this.repository.listReplicas(file.id);
    const synchronousReplicaSpecs = replicas.filter(replica => replica.role !== 'async_backup');
    const channels = await Promise.all(synchronousReplicaSpecs.map(replica => this.repository.getChannel(replica.channel_id)));
    if (channels.some(channel => !channel?.enabled || ['offline', 'disabled', 'quota_blocked'].includes(channel.health_status))) throw new Error('A synchronous storage channel is not writable');
    const mode = input.mode || policy.write_mode || 'safe';
    const synchronousReplicas = mode === 'fast' ? synchronousReplicaSpecs.slice(0, 1) : synchronousReplicaSpecs;
    const bodies = splitBody(input.body, synchronousReplicas.length); const results = await Promise.all(synchronousReplicas.map((replica, index) => this.orchestrator.writeReplica(file, replica, channels[index], { body: bodies[index], size: input.size, contentType: input.contentType, name: input.name, idempotencyKey: input.idempotencyKey })));
    const updated = await this.orchestrator.recomputeFileHealth(file.id);
    if (mode === 'fast' && synchronousReplicaSpecs[1] && level === 'NORMAL') await this.createRepair(updated, synchronousReplicaSpecs[1]);
    if (updated.status !== 'available') for (const result of results.filter(result => result.error)) await this.createRepair(updated, result.replica);
    if (updated.status !== 'failed') for (const replica of replicas.filter(replica => replica.role === 'async_backup')) await this.createReplica(updated, replica);
    if (mode === 'strict' && updated.status !== 'available') { const error = new Error('Strict upload requires both replicas'); error.status = 503; throw error; }
    await this.guard.record({ uploads: 1, d1_writes: 1 }); return { file: updated, replicas: await this.repository.listReplicas(file.id), degraded: updated.status === 'degraded' };
  }
  async validate(input) { if (!input.body || !input.name || !input.contentType || !Number.isFinite(input.size) || input.size < 0) throw new Error('A file body, name, content type, and size are required'); if (input.size > this.guard.limits.HARD_MAX_UPLOAD_BYTES) { const error = new Error('File exceeds hard upload limit'); error.status = 413; throw error; } if (input.size > this.guard.limits.MAX_UPLOAD_BYTES && !input.admin) { const error = new Error('File exceeds default upload limit'); error.status = 413; throw error; } if (!input.idempotencyKey || String(input.idempotencyKey).length > 200) { const error = new Error('A bounded Idempotency-Key is required'); error.status = 400; throw error; } if (/[\0]/.test(input.name) || input.name.includes('..')) { const error = new Error('Unsafe file name'); error.status = 400; throw error; } if (!/^[\w.+-]+\/[\w.+-]+$/i.test(input.contentType)) { const error = new Error('Invalid content type'); error.status = 400; throw error; } }
  async createRepair(file, replica) { if (!this.jobService || file.status === 'deleted') return; try { await this.guard.assertRepair({ critical: file.status === 'failed' }); } catch (error) { if (error.code === 'ZERO_COST_GUARD') return null; throw error; } return this.jobService.create({ id: `job_${crypto.randomUUID()}`, fileId: file.id, replicaId: replica.id, channelId: replica.channel_id, operation: 'REPAIR_REPLICA', generation: file.generation, idempotencyKey: `repair:${file.id}:${replica.id}:${file.generation}` }); }
  async createReplica(file, replica) { if (!this.jobService || file.status === 'deleted') return; try { await this.guard.assertAsyncReplica(); } catch (error) { if (error.code === 'ZERO_COST_GUARD') return null; throw error; } return this.jobService.create({ id: `job_${crypto.randomUUID()}`, fileId: file.id, replicaId: replica.id, channelId: replica.channel_id, operation: 'CREATE_REPLICA', generation: file.generation, idempotencyKey: `create:${file.id}:${replica.id}:${file.generation}` }); }
}
function safeName(name) { return String(name).replace(/[\\/\0]/g, '_').slice(0, 240); }
function splitBody(body, count) { if (count === 1) return [body]; if (body?.tee) { const [first, second] = body.tee(); return [first, second]; } if (body instanceof Blob) return Array.from({ length: count }, () => body.slice(0, body.size, body.type)); return Array.from({ length: count }, () => body); }
