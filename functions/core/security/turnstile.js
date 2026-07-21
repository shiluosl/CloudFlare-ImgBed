const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TURNSTILE_TIMEOUT_MS = 5000;

export async function verifyTurnstile({ token, secret, remoteIp, idempotencyKey, fetchFn = fetch }) {
  if (!token || !secret) return false;
  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set('remoteip', remoteIp);
  if (idempotencyKey) body.set('idempotency_key', idempotencyKey);

  try {
    const response = await fetchFn(TURNSTILE_SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: timeoutSignal(),
    });
    if (!response.ok) return false;
    const result = await response.json();
    return result?.success === true;
  } catch {
    return false;
  }
}

export function requestRemoteIp(request) {
  const value = request.headers.get('CF-Connecting-IP');
  return value && /^[0-9a-f:.]{3,45}$/i.test(value) ? value : undefined;
}

function timeoutSignal() {
  return typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(TURNSTILE_TIMEOUT_MS) : undefined;
}
