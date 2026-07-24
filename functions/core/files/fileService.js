export class FileService {
  constructor(runtime) { this.runtime = runtime; }
  async read(fileId, request) {
    const { repository, storage, jobs, health, guard } = this.runtime; const file = await repository.getFile(fileId);
    if (!file || ['deleted', 'deleting', 'delete_degraded'].includes(file.status) || await repository.getTombstone(fileId)) return { response: new Response('Not Found', { status: 404 }) };
    const candidates = await storage.readCandidates(fileId); if (!candidates.length) return { response: new Response('File temporarily unavailable', { status: 503 }) };
    let readSideEffectsAllowed = null;
    const mayWriteReadState = async () => {
      if (readSideEffectsAllowed !== null) return readSideEffectsAllowed;
      try {
        // A read remains available at every protection level. Its optional
        // health, repair, and audit writes are ordinary repair work instead.
        await guard?.assertRepair({ critical: false });
        readSideEffectsAllowed = true;
      } catch (error) {
        if (error.code !== 'ZERO_COST_GUARD') throw error;
        readSideEffectsAllowed = false;
      }
      return readSideEffectsAllowed;
    };
    let previousError = null;
    for (let index = 0; index < candidates.length; index += 1) { const replica = candidates[index]; try { const remote = await storage.openReplica(replica, request.headers.get('Range')); const sideEffects = await mayWriteReadState(); if (sideEffects) await health?.recordSuccess(replica); if (index > 0 && sideEffects) { await repository.updateReplica(candidates[0].id, { status: 'suspect', last_error_code: previousError?.code || 'READ_FAILED', last_error_message: safeMessage(previousError) }); await jobs.create({ id: `job_${crypto.randomUUID()}`, fileId, replicaId: candidates[0].id, channelId: candidates[0].channel_id, operation: 'REPAIR_REPLICA', generation: file.generation, idempotencyKey: `read-repair:${fileId}:${candidates[0].id}:${file.generation}` }); await auditReadFallback(repository, fileId, candidates[0].id, replica.id, previousError?.code); }
        const headers = new Headers(remote.headers); headers.set('Content-Type', file.content_type || 'application/octet-stream'); headers.set('Content-Disposition', disposition(file.name, file.content_type)); headers.set('X-Content-Type-Options', 'nosniff'); headers.set('Referrer-Policy', 'no-referrer'); headers.set('Cache-Control', 'private, no-store'); return { response: new Response(request.method === 'HEAD' ? null : remote.body, { status: remote.status, headers }) };
      } catch (error) { previousError = error; if (await mayWriteReadState()) await health?.recordFailure(replica, error); }
    }
    return { response: new Response('File temporarily unavailable', { status: 503 }) };
  }
  async delete(fileId, actorId) {
    const { repository, jobs, guard } = this.runtime; await guard?.assertDelete({ admin: true }); const file = await repository.getFile(fileId); if (!file || file.status === 'deleted') return null;
    const replicas = await repository.listReplicas(fileId);
    const existing = await repository.getTombstone(fileId);
    const generation = existing?.generation || file.generation + 1;
    const deletionJobs = replicas.filter(replica => replica.status !== 'deleted').map(replica => ({
      id: `job_${crypto.randomUUID()}`,
      fileId,
      replicaId: replica.id,
      channelId: replica.channel_id,
      operation: 'DELETE_REPLICA',
      generation,
      idempotencyKey: `delete:${fileId}:${replica.id}:${generation}`,
    }));
    if (repository.beginDeletion) {
      const tombstone = await repository.beginDeletion({ fileId, expectedGeneration: file.generation, actorId, reason: 'user_delete', jobs: deletionJobs });
      // The batch is the durable source of truth. Queue delivery is only an
      // eager wake-up and cron can redispatch any send that does not happen.
      for (const job of deletionJobs) await jobs.create(job, { essential: true });
      return tombstone;
    }
    if (existing) return existing;
    const expectedGeneration = file.generation;
    const tombstone = await repository.createTombstone(fileId, expectedGeneration, actorId, 'user_delete');
    if (!tombstone || tombstone.generation !== expectedGeneration + 1) return repository.getTombstone(fileId);
    for (const replica of replicas.filter(replica => replica.status !== 'deleted')) {
      await repository.updateReplica(replica.id, { status: 'deleting' });
      await jobs.create(deletionJobs.find(job => job.replicaId === replica.id), { essential: true });
    }
    return tombstone;
  }
}
function disposition(name, type) { const unsafe = /^(text\/html|image\/svg\+xml|application\/xhtml\+xml)$/i.test(type); return `${unsafe ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`; }
function safeMessage(error) { return String(error?.message || 'Primary read failed').replace(/(bearer|basic)\s+[^\s]+/gi, '$1 [redacted]').slice(0, 500); }
async function auditReadFallback(repository, fileId, failedReplicaId, servedReplicaId, errorCode) {
  if (!repository.audit) return;
  try {
    await repository.audit({ id: `audit_${crypto.randomUUID()}`, action: 'file.readFallback', targetType: 'file', targetId: fileId, details: { failedReplicaId, servedReplicaId, errorCode: errorCode || 'READ_FAILED' } });
  } catch (error) {
    console.warn('Failed to audit read fallback:', safeMessage(error));
  }
}
