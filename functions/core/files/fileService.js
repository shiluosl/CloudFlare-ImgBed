import { assertFileTransition, assertReplicaTransition } from '../state/statusMachine.js';

export class FileService {
  constructor(runtime) { this.runtime = runtime; }
  async read(fileId, request) {
    const { repository, storage, jobs } = this.runtime; const file = await repository.getFile(fileId);
    if (!file || ['deleted', 'deleting', 'delete_degraded'].includes(file.status) || await repository.getTombstone(fileId)) return { response: new Response('Not Found', { status: 404 }) };
    const candidates = await storage.readCandidates(fileId); if (!candidates.length) return { response: new Response('File temporarily unavailable', { status: 503 }) };
    let previousError = null;
    for (let index = 0; index < candidates.length; index += 1) { const replica = candidates[index]; try { const remote = await storage.openReplica(replica, request.headers.get('Range')); if (index > 0) { await repository.updateReplica(candidates[0].id, { status: 'suspect', last_error_code: previousError?.code || 'READ_FAILED', last_error_message: previousError?.message || 'Primary read failed' }); await jobs.create({ id: `job_${crypto.randomUUID()}`, fileId, replicaId: candidates[0].id, channelId: candidates[0].channel_id, operation: 'REPAIR_REPLICA', generation: file.generation, idempotencyKey: `read-repair:${fileId}:${candidates[0].id}:${file.generation}` }); }
        const headers = new Headers(remote.headers); headers.set('Content-Disposition', disposition(file.name, file.content_type)); headers.set('X-Content-Type-Options', 'nosniff'); headers.set('Referrer-Policy', 'no-referrer'); headers.set('Cache-Control', file.is_public ? 'public, max-age=3600, s-maxage=3600' : 'private, no-store'); return { response: new Response(request.method === 'HEAD' ? null : remote.body, { status: remote.status, headers }) };
      } catch (error) { previousError = error; }
    }
    return { response: new Response('File temporarily unavailable', { status: 503 }) };
  }
  async delete(fileId, actorId) {
    const { repository, jobs } = this.runtime; const file = await repository.getFile(fileId); if (!file || file.status === 'deleted') return null;
    const existing = await repository.getTombstone(fileId); if (existing) return existing;
    const tombstone = await repository.createTombstone(fileId, file.generation, actorId, 'user_delete'); const replicas = await repository.listReplicas(fileId);
    for (const replica of replicas.filter(replica => replica.status !== 'deleted')) { await repository.updateReplica(replica.id, { status: 'deleting' }); await jobs.create({ id: `job_${crypto.randomUUID()}`, fileId, replicaId: replica.id, channelId: replica.channel_id, operation: 'DELETE_REPLICA', generation: tombstone.generation, idempotencyKey: `delete:${fileId}:${replica.id}:${tombstone.generation}` }, { essential: true }); }
    return tombstone;
  }
}
function disposition(name, type) { const unsafe = /^(text\/html|image\/svg\+xml|application\/xhtml\+xml)$/i.test(type); return `${unsafe ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`; }
