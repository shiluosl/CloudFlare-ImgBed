import { runtime } from '../../../core/runtime.js';

export async function onRequestGet({ request, env }) {
  const app = runtime(env);
  const url = new URL(request.url);
  const items = await app.repository.listAudits({ limit: url.searchParams.get('limit'), cursor: url.searchParams.get('cursor') });
  return Response.json({ items, nextCursor: items.length ? items.at(-1).cursor || null : null });
}
