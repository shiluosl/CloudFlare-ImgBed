import { runtime } from '../../../core/runtime.js';

export async function onRequestGet({ request, env }) {
  const app = runtime(env);
  const url = new URL(request.url);
  const items = await app.repository.listPolicies({ limit: url.searchParams.get('limit'), cursor: url.searchParams.get('cursor') });
  return Response.json({ items: items.map(publicPolicy), nextCursor: items.length ? items.at(-1).cursor || null : null });
}

export async function onRequestPost({ request, env }) {
  const body = await parseBody(request);
  if (!body) return invalidJson();
  try {
    const app = runtime(env);
    await app.guard.assertWrite({ admin: true });
    const error = await validatePolicy(app.repository, body);
    if (error) return Response.json({ error }, { status: 400 });
    const policy = await app.repository.createPolicy({
      id: body.id || `policy_${crypto.randomUUID()}`,
      name: body.name,
      enabled: body.enabled !== false,
      writeMode: body.writeMode || 'safe',
      primaryChannelId: body.primaryChannelId,
      syncBackupChannelId: body.syncBackupChannelId || null,
      asyncChannelIds: body.asyncChannelIds || [],
      requiredCopies: body.requiredCopies || 2,
      minimumReadableCopies: body.minimumReadableCopies || 1,
      autoRepair: body.autoRepair !== false,
      stopWhenQuotaRisk: body.stopWhenQuotaRisk !== false,
    });
    await app.repository.audit({ id: `audit_${crypto.randomUUID()}`, action: 'policy.created', targetType: 'storage_policy', targetId: policy.id, details: { writeMode: policy.write_mode } });
    return Response.json(publicPolicy(policy), { status: 201 });
  } catch (error) { return operationError(error); }
}

export async function onRequestPatch({ request, env }) {
  const body = await parseBody(request);
  if (!body) return invalidJson();
  if (!body.id) return Response.json({ error: 'id is required' }, { status: 400 });
  try {
    const app = runtime(env);
    await app.guard.assertWrite({ admin: true });
    const current = await app.repository.getPolicy(body.id);
    if (!current) return Response.json({ error: 'Policy not found' }, { status: 404 });
    const candidate = {
      ...current,
      ...body,
      primaryChannelId: body.primaryChannelId ?? current.primary_channel_id,
      syncBackupChannelId: body.syncBackupChannelId ?? current.sync_backup_channel_id,
      asyncChannelIds: body.asyncChannelIds ?? JSON.parse(current.async_channels_json || '[]'),
      writeMode: body.writeMode ?? current.write_mode,
      name: body.name ?? current.name,
      requiredCopies: body.requiredCopies ?? current.required_copies,
      minimumReadableCopies: body.minimumReadableCopies ?? current.minimum_readable_copies,
      autoRepair: body.autoRepair ?? Boolean(current.auto_repair),
      stopWhenQuotaRisk: body.stopWhenQuotaRisk ?? Boolean(current.stop_when_quota_risk),
    };
    const error = await validatePolicy(app.repository, candidate);
    if (error) return Response.json({ error }, { status: 400 });
    const policy = await app.repository.updatePolicy(body.id, body);
    await app.repository.audit({ id: `audit_${crypto.randomUUID()}`, action: 'policy.updated', targetType: 'storage_policy', targetId: policy.id });
    return Response.json(publicPolicy(policy));
  } catch (error) { return operationError(error); }
}

async function validatePolicy(repository, body) {
  if (!body.name || !body.primaryChannelId || !body.syncBackupChannelId) return 'name, primaryChannelId, and syncBackupChannelId are required';
  if (!['safe', 'strict', 'fast'].includes(body.writeMode || 'safe')) return 'Unsupported writeMode';
  const requiredCopies = Number(body.requiredCopies ?? 2);
  const minimumReadableCopies = Number(body.minimumReadableCopies ?? 1);
  if (!Number.isInteger(requiredCopies) || requiredCopies < 1 || requiredCopies > 2) return 'requiredCopies must be an integer between 1 and 2';
  if (!Number.isInteger(minimumReadableCopies) || minimumReadableCopies < 1 || minimumReadableCopies > requiredCopies) return 'minimumReadableCopies must be between 1 and requiredCopies';
  if (body.syncBackupChannelId && body.syncBackupChannelId === body.primaryChannelId) return 'Primary and sync backup channels must differ';
  const ids = [body.primaryChannelId, body.syncBackupChannelId, ...(body.asyncChannelIds || [])].filter(Boolean);
  if (new Set(ids).size !== ids.length) return 'Policy channels must be unique';
  const channels = await Promise.all(ids.map(id => repository.getChannel(id)));
  if (channels.some(channel => !channel)) return 'Every policy channel must exist';
  if (channels.some(channel => channel.provider === 'r2')) return 'R2 is disabled in Zero-Cost mode';
  if (body.syncBackupChannelId && channels[0]?.failure_domain === channels[1]?.failure_domain) return 'Primary and sync backup channels must use different failure domains';
  return null;
}

function publicPolicy(policy) {
  return { ...policy, async_channels: JSON.parse(policy.async_channels_json || '[]') };
}

async function parseBody(request) { try { const body = await request.json(); return body && typeof body === 'object' && !Array.isArray(body) ? body : null; } catch { return null; } }
function invalidJson() { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }
function operationError(error) { return Response.json({ error: error.code === 'ZERO_COST_GUARD' ? 'Operation is paused by the Zero-Cost Guard' : error.message || 'Policy operation failed', code: error.code || 'POLICY_OPERATION_FAILED', protectionLevel: error.level || null }, { status: error.code === 'ZERO_COST_GUARD' ? 503 : 400 }); }
