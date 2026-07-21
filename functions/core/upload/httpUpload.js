export const MAX_FILES_PER_REQUEST = 5;

export async function readMultipartUpload(request) {
  const data = await request.formData();
  const files = uploadFiles(data);
  if (!files.length) throw clientError('file is required', 400);
  if (files.length > MAX_FILES_PER_REQUEST) throw clientError(`A request may contain at most ${MAX_FILES_PER_REQUEST} files`, 413);
  const idempotencyKey = request.headers.get('Idempotency-Key');
  if (!idempotencyKey) throw clientError('Idempotency-Key is required', 400);
  if (idempotencyKey.length > (files.length === 1 ? 200 : 198)) throw clientError('Idempotency-Key is too long for this upload batch', 400);
  return { data, files, idempotencyKey, ids: data.getAll('fileId') };
}

export async function processUploadBatch({ app, data, files, ids = [], idempotencyKey, buildInput, auditAction = 'file.uploaded' }) {
  const items = [];
  for (const [index, file] of files.entries()) {
    try {
      const result = await app.upload.upload(buildInput({ file, index, idempotencyKey: batchIdempotencyKey(idempotencyKey, files.length, index), data, id: ids[index] || undefined }));
      await app.repository.audit({ id: `audit_${crypto.randomUUID()}`, action: result.degraded ? 'file.degraded' : auditAction, targetType: 'file', targetId: result.file.id });
      items.push(publicResult(result));
    } catch (error) {
      items.push({ name: file.name, error: error.message, code: error.code || 'UPLOAD_FAILED', protectionLevel: error.level || null, status: error.status || (error.code === 'ZERO_COST_GUARD' ? 503 : 400) });
    }
  }
  return items;
}

export function uploadResponse(items) {
  if (items.length === 1 && !items[0].error) return Response.json(items[0], { status: items[0].degraded ? 202 : 201 });
  if (items.length === 1) {
    const item = items[0];
    return Response.json({ error: item.error, code: item.code, protectionLevel: item.protectionLevel }, { status: item.status });
  }
  const partial = items.some(item => item.error);
  return Response.json({ items, partial }, { status: partial ? 207 : 201 });
}

export function uploadFiles(data) {
  return data.getAll('file').filter(value => value instanceof File);
}

function batchIdempotencyKey(idempotencyKey, fileCount, index) {
  return fileCount === 1 ? idempotencyKey : `${idempotencyKey}:${index}`;
}

function publicResult(result) {
  return {
    file: { id: result.file.id, status: result.file.status, name: result.file.name, contentType: result.file.content_type, size: result.file.size },
    replicas: result.replicas,
    url: `/file/${result.file.id}`,
    degraded: result.degraded,
    idempotent: result.idempotent || false,
  };
}

function clientError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}
