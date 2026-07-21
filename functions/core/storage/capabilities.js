const BASE_CAPABILITIES = Object.freeze({
  read: true,
  write: true,
  delete: true,
  head: true,
  range: false,
  checksum: false,
  maxObjectSize: null,
});

const PROVIDER_CAPABILITIES = Object.freeze({
  webdav: { ...BASE_CAPABILITIES, range: true },
  telegram: { ...BASE_CAPABILITIES, range: true, maxObjectSize: 20 * 1024 * 1024 },
  s3: { ...BASE_CAPABILITIES, range: true, checksum: true },
});

export function providerCapabilities(provider) {
  const capabilities = PROVIDER_CAPABILITIES[provider];
  return capabilities ? { ...capabilities } : null;
}

export function effectiveChannelCapabilities(channel) {
  const base = providerCapabilities(channel?.provider);
  if (!base) return null;
  const configured = parseCapabilities(channel?.capabilities ?? channel?.capabilities_json);
  const result = { ...base };

  for (const name of ['read', 'write', 'delete', 'head', 'range', 'checksum']) {
    // Channel configuration may restrict a provider capability, never grant one
    // the adapter cannot implement.
    if (configured[name] === false) result[name] = false;
  }

  const configuredMax = boundedMaxObjectSize(configured.maxObjectSize);
  if (configuredMax !== null) {
    result.maxObjectSize = result.maxObjectSize === null
      ? configuredMax
      : Math.min(result.maxObjectSize, configuredMax);
  }
  return result;
}

export function hasRequiredCapabilities(channel, required) {
  const capabilities = effectiveChannelCapabilities(channel);
  return Boolean(capabilities && required.every(name => capabilities[name] === true));
}

export function exceedsChannelObjectLimit(channel, size) {
  const limit = effectiveChannelCapabilities(channel)?.maxObjectSize;
  return Number.isFinite(limit) && Number(size) > limit;
}

function parseCapabilities(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function boundedMaxObjectSize(value) {
  const size = Number(value);
  return Number.isFinite(size) && size > 0 ? Math.floor(size) : null;
}
