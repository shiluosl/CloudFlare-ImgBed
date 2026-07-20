import { runtime } from '../../../core/runtime.js';

export async function onRequestGet({ request, env }) {
  const app = runtime(env);
  const url = new URL(request.url);
  const items = await app.repository.listPolicies({ limit: url.searchParams.get('limit'), cursor: url.searchParams.get('cursor') });
  return Response.json({ items: items.map(publicPolicy), nextCursor: items.length ? items.at(-1).cursor || null : null });
}

export async function onRequestPost({ request, env }) {
  const body = await request.json();
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
}

async function validatePolicy(repository, body) {
  if (!body.name || !body.primaryChannelId) return 'name and primaryChannelId are required';
  if (!['safe', 'strict', 'fast'].includes(body.writeMode || 'safe')) return 'Unsupported writeMode';
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
