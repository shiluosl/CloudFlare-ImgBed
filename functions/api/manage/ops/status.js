import { runtime } from '../../../core/runtime.js';
export async function onRequestGet({ env }) { const app = runtime(env); const status = await app.guard.status(); return Response.json({ ...status, r2Disabled: true, mode: 'zero-cost' }, { headers: { 'Cache-Control': 'private, no-store' } }); }
