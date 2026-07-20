import { runtime } from '../../../core/runtime.js';
import { v3UploadEnabled } from '../../../core/config.js';
const MAX_FILES_PER_REQUEST = 5;

export async function onRequestPost({ request, env }) {
  if (!v3UploadEnabled(env)) return Response.json({ error: 'V3 uploads are disabled', code: 'V3_UPLOAD_DISABLED' }, { status: 503 });
  const data = await request.formData();
  const files = uploadFiles(data);
  if (!files.length) return Response.json({ error: 'file is required' }, { status: 400 });
  if (files.length > MAX_FILES_PER_REQUEST) return Response.json({ error: `A request may contain at most ${MAX_FILES_PER_REQUEST} files` }, { status: 413 });
  const idempotencyKey = request.headers.get('Idempotency-Key');
  if (!idempotencyKey) return Response.json({ error: 'Idempotency-Key is required' }, { status: 400 });
  if (idempotencyKey.length > (files.length === 1 ? 200 : 198)) return Response.json({ error: 'Idempotency-Key is too long for this upload batch' }, { status: 400 });
  const app = runtime(env);
  const ids = data.getAll('fileId');
  const mode = data.get('mode') || undefined;
  const items = [];
  for (const [index, file] of files.entries()) {
    try {
      const result = await app.upload.upload({
        id: ids[index] || undefined,
        idempotencyKey: files.length === 1 ? idempotencyKey : `${idempotencyKey}:${index}`,
        ownerId: data.get('ownerId') || null,
        policyId: data.get('policyId'),
        mode,
        name: file.name,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
        body: file.stream(),
        isPublic: data.get('isPublic') !== 'false',
        admin: true,
      });
      await app.repository.audit({ id: `audit_${crypto.randomUUID()}`, action: result.degraded ? 'file.degraded' : 'file.uploaded', targetType: 'file', targetId: result.file.id });
      items.push(publicResult(result));
    } catch (error) {
      items.push({ name: file.name, error: error.message, code: error.code || 'UPLOAD_FAILED', protectionLevel: error.level || null, status: error.status || (error.code === 'ZERO_COST_GUARD' ? 503 : 400) });
    }
  }
  if (files.length === 1 && !items[0].error) return Response.json(items[0], { status: items[0].degraded ? 202 : 201 });
  if (files.length === 1) {
    const item = items[0];
    return Response.json({ error: item.error, code: item.code, protectionLevel: item.protectionLevel }, { status: item.status });
  }
  const partial = items.some(item => item.error);
  return Response.json({ items, partial }, { status: partial ? 207 : 201 });
}

export function uploadFiles(data) { return data.getAll('file').filter(value => value instanceof File); }
function publicResult(result) { return { file: publicFile(result.file), replicas: result.replicas, url: `/file/${result.file.id}`, degraded: result.degraded, idempotent: result.idempotent || false }; }
function publicFile(file) { return { id: file.id, status: file.status, name: file.name, contentType: file.content_type, size: file.size }; }
