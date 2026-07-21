import { runtime } from '../../core/runtime.js';
import { anonymousV3UploadEnabled } from '../../core/config.js';
import { requestRemoteIp, verifyTurnstile } from '../../core/security/turnstile.js';
import { processUploadBatch, readMultipartUpload, uploadResponse } from '../../core/upload/httpUpload.js';

export async function onRequestPost({ request, env }, dependencies = {}) {
  if (!anonymousV3UploadEnabled(env)) return Response.json({ error: 'Anonymous V3 uploads are disabled', code: 'ANONYMOUS_UPLOAD_DISABLED' }, { status: 503 });
  let multipart;
  try { multipart = await readMultipartUpload(request); } catch (error) { return Response.json({ error: error.message }, { status: error.status || 400 }); }

  const approved = await (dependencies.verifyTurnstile || verifyTurnstile)({
    token: multipart.data.get('cf-turnstile-response'),
    secret: env.TURNSTILE_SECRET,
    remoteIp: requestRemoteIp(request),
    idempotencyKey: multipart.idempotencyKey,
  });
  if (!approved) return Response.json({ error: 'Turnstile verification failed', code: 'TURNSTILE_FAILED' }, { status: 403 });

  const app = (dependencies.runtime || runtime)(env);
  const items = await processUploadBatch({
    app,
    data: multipart.data,
    files: multipart.files,
    idempotencyKey: multipart.idempotencyKey,
    auditAction: 'file.anonymousUploaded',
    buildInput: ({ file, idempotencyKey }) => ({
      idempotencyKey,
      ownerId: null,
      policyId: multipart.data.get('policyId'),
      mode: 'safe',
      name: file.name,
      contentType: file.type || 'application/octet-stream',
      size: file.size,
      body: file.stream(),
      isPublic: true,
      admin: false,
    }),
  });
  return uploadResponse(items);
}
