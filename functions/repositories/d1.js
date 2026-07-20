export function requireD1(env) {
  const db = env?.DB || env?.img_d1;
  if (!db || typeof db.prepare !== 'function') {
    const error = new Error('V3 storage requires a D1 binding named DB (or legacy img_d1)');
    error.code = 'D1_REQUIRED';
    throw error;
  }
  return db;
}

export async function first(statement) {
  const result = await statement.first();
  return result || null;
}

export async function all(statement) {
  const result = await statement.all();
  return result.results || [];
}

export function now() {
  return Date.now();
}

export function json(value, fallback = {}) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

export function page(limit, cursor) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  return { limit: safeLimit, cursor: Number(cursor) || 0 };
}
