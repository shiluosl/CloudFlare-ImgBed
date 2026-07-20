import { runtime } from '../../../core/runtime.js';
export async function onRequestGet({ env }) {
  const app = runtime(env);
  const status = await app.guard.status();
  const level = status.level;
  const forbidden = {
    WARNING: ['full verification', 'bulk migration', 'third replicas', 'frequent health checks'],
    WRITE_LIMITED: ['anonymous uploads', 'bulk uploads', 'non-essential repair', 'bulk import'],
    READ_ONLY: ['uploads', 'registration', 'channel creation', 'policy changes', 'ordinary repair'],
    EMERGENCY: ['all writes except minimal safety controls'],
  };
  return Response.json({
    ...status,
    r2Disabled: true,
    mode: 'zero-cost',
    readOnly: ['READ_ONLY', 'EMERGENCY'].includes(level),
    forbiddenFeatures: forbidden[level] || [],
    databaseBytesEstimate: status.usage?.database_bytes_estimate || 0,
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}
