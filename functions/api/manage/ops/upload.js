import { runtime } from '../../../core/runtime.js';
import { v3UploadEnabled } from '../../../core/config.js';
import { processUploadBatch, readMultipartUpload, uploadFiles, uploadResponse } from '../../../core/upload/httpUpload.js';

export async function onRequestPost({ request, env }) {
  if (!v3UploadEnabled(env)) return Response.json({ error: 'V3 uploads are disabled', code: 'V3_UPLOAD_DISABLED' }, { status: 503 });
  let multipart;
  try { multipart = await readMultipartUpload(request); } catch (error) { return Response.json({ error: error.message }, { status: error.status || 400 }); }
  const { data, files, idempotencyKey, ids } = multipart;
  const app = runtime(env);
  const mode = data.get('mode') || undefined;
  const items = await processUploadBatch({
    app, data, files, ids, idempotencyKey,
    buildInput: ({ file, id, idempotencyKey: itemIdempotencyKey }) => ({
        id,
        idempotencyKey: itemIdempotencyKey,
        ownerId: data.get('ownerId') || null,
        policyId: data.get('policyId'),
        mode,
        name: file.name,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
        body: file.stream(),
        isPublic: data.get('isPublic') !== 'false',
        admin: true,
      }),
  });
  return uploadResponse(items);
}

export { uploadFiles };
