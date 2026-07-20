import { runtime } from '../runtime.js';

const DEFAULT_SAMPLE_RATE = 100;

export function workerRequestSampleRate(env = {}) {
  const configured = Number(env.WORKER_REQUEST_SAMPLE_RATE);
  if (!Number.isFinite(configured)) return DEFAULT_SAMPLE_RATE;
  return Math.min(Math.max(Math.floor(configured), 1), 10_000);
}

export function requestMarker(input) {
  if (input instanceof Request) {
    const ray = input.headers.get('cf-ray');
    if (ray) return `ray:${ray}`;
    const url = new URL(input.url);
    return `request:${input.method}:${url.pathname}:${Math.floor(Date.now() / 60_000)}`;
  }
  return String(input || 'worker');
}

export function shouldEstimateWorkerRequest(input, env = {}) {
  return stableHash(requestMarker(input)) % workerRequestSampleRate(env) === 0;
}

export async function recordWorkerRequestEstimate(env, input, createRuntime = runtime) {
  if (!shouldEstimateWorkerRequest(input, env)) return false;
  const sampleRate = workerRequestSampleRate(env);
  try {
    await createRuntime(env).guard.record({ worker_requests: sampleRate });
    return true;
  } catch (error) {
    // Metering is advisory and must never turn a public read into a failure.
    console.warn('Unable to record sampled Worker usage:', sanitizeMessage(error));
    return false;
  }
}

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function sanitizeMessage(error) {
  return String(error?.message || 'unknown error')
    .replace(/(bearer|basic)\s+[^\s]+/gi, '$1 [redacted]')
    .slice(0, 160);
}
