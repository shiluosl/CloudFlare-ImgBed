const PRIVATE_HOSTS = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal']);

export function assertExternalEndpoint(value, { allowPrivate = false, label = 'Endpoint' } = {}) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw invalid(`${label} must be a valid URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw invalid(`${label} must use http or https without URL credentials`);
  if (!allowPrivate && isPrivateHost(url.hostname)) throw invalid(`${label} may not target localhost or a private address`);
  return url;
}

function isPrivateHost(host) {
  const value = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (PRIVATE_HOSTS.has(value) || value.endsWith('.localhost')) return true;
  if (/^127\./.test(value) || /^10\./.test(value) || /^192\.168\./.test(value) || /^169\.254\./.test(value) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(value) || /^0\./.test(value)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(value) || value === '::' || value === '::1' || /^::ffff:/i.test(value) || /^f[cd][0-9a-f:]*$/i.test(value) || /^fe80:/i.test(value)) return true;
  return false;
}

function invalid(message) { const error = new Error(message); error.code = 'INVALID_ENDPOINT'; return error; }
