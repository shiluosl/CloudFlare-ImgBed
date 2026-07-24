import { runtime } from '../../core/runtime.js';
import { anonymousV3UploadEnabled, v3UploadEnabled } from '../../core/config.js';
import { requestRemoteIp, verifyTurnstile } from '../../core/security/turnstile.js';
import { processUploadBatch, readMultipartUpload, uploadResponse } from '../../core/upload/httpUpload.js';
import { userAuthCheck } from '../../utils/auth/userAuth.js';

export async function onRequestPost({ request, env }, dependencies = {}) {
  if (!v3UploadEnabled(env)) return Response.json({ error: 'V3 uploads are disabled', code: 'V3_UPLOAD_DISABLED' }, { status: 503 });
  if (!anonymousV3UploadEnabled(env)) return passwordUpload(request, env, dependencies);

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

async function passwordUpload(request, env, dependencies) {
  let authenticated;
  try {
    authenticated = await (dependencies.userAuthCheck || userAuthCheck)(env, new URL(request.url), request, 'upload');
  } catch (error) {
    console.error('Password-gated V3 upload authentication is unavailable:', String(error?.message || 'unknown error').slice(0, 200));
    return Response.json({ error: 'Upload authentication is temporarily unavailable', code: 'UPLOAD_AUTH_UNAVAILABLE' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  if (!authenticated) {
    return Response.json({ error: 'Upload password verification is required', code: 'UPLOAD_AUTH_REQUIRED' }, {
      status: 401,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const policyId = String(env.V3_DEFAULT_POLICY_ID || '').trim();
  if (!policyId) {
    return Response.json({ error: 'V3 default storage policy is not configured', code: 'V3_DEFAULT_POLICY_REQUIRED' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  let multipart;
  try { multipart = await readMultipartUpload(request); } catch (error) { return Response.json({ error: error.message }, { status: error.status || 400 }); }
  const app = (dependencies.runtime || runtime)(env);
  const items = await processUploadBatch({
    app,
    data: multipart.data,
    files: multipart.files,
    idempotencyKey: multipart.idempotencyKey,
    auditAction: 'file.passwordAuthenticatedUploaded',
    buildInput: ({ file, idempotencyKey }) => ({
      idempotencyKey,
      ownerId: null,
      policyId,
      // Password-gated public uploads deliberately keep the durable default.
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
