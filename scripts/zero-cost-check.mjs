import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  ['deploy/worker/wrangler.toml', /r2_buckets/i, 'Worker configuration declares an R2 binding'],
  ['deploy/worker/wrangler.toml', /ALLOW_R2\s*=\s*"true"/i, 'Worker configuration enables R2'],
  ['deploy/worker/generate-toml.js', /\[\[r2_buckets\]\]/i, 'Deployment generator can create an R2 binding'],
  ['.github/workflows/deploy-worker.yml', /R2_BUCKET_NAME/i, 'Deployment workflow passes an R2 setting'],
  ['wrangler.toml.example', /r2_buckets/i, 'Example Worker configuration declares an R2 binding'],
  ['deploy/worker/wrangler.toml', /\[\[kv_namespaces\]\]/i, 'V3 Worker configuration declares a forbidden KV binding'],
  ['deploy/worker/generate-toml.js', /\[\[kv_namespaces\]\]/i, 'Deployment generator can create a forbidden KV binding'],
  ['.github/workflows/deploy-worker.yml', /KV_NAMESPACE_ID/i, 'Deployment workflow passes a forbidden KV setting'],
];
const forbiddenBinding = [
  /\bworkers_ai\s*=|\bai\s*=/i,
  /\bvectorize\s*=/i,
  /browser[_ -]?rendering\s*=/i,
  /\bcontainers\s*=/i,
];
const activeSourceChecks = [
  ['functions/core/storage/registry.js', /provider\s*===\s*['"]r2['"]\s*&&\s*!r2Allowed/i, 'V3 adapter registry must reject R2'],
  ['deploy/worker/index.js', /r2_buckets/i, 'Generated Worker declares an R2 binding'],
  ['deploy/worker/index.js', /zeroCostEnvironment[\s\S]*property === 'img_r2'/i, 'Generated Worker must hide legacy R2 bindings in Zero-Cost mode'],
];
const v3SourceFiles = [
  'functions/core/storage/registry.js',
  'functions/core/storage/orchestrator.js',
  'functions/adapters/webdav/webdavAdapter.js',
  'functions/adapters/telegram/telegramAdapter.js',
  'functions/adapters/s3/s3Adapter.js',
  'functions/api/manage/ops/channels.js',
];
const forbiddenV3Patterns = [
  [/env\.(?:R2|img_r2)\b/, 'V3 source accesses a forbidden R2 binding'],
  [/provider\s*:\s*['"]r2['"]/, 'V3 source creates an R2 provider'],
  [/ALLOW_R2\s*=\s*['"]true['"]/, 'V3 source enables R2'],
  [/\bworkers_ai\b|\bvectorize\b|browser[_ -]?rendering|\bcontainers\b/i, 'V3 source mentions a forbidden paid Cloudflare feature'],
];
export function inspectZeroCostFiles(baseDir = root) {
  const read = file => {
    const absolute = resolve(baseDir, file);
    return existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
  };
  const failures = [];
  for (const [file, pattern, message] of required) {
    if (pattern.test(read(file))) failures.push(`${message}: ${file}`);
  }
  for (const file of ['deploy/worker/wrangler.toml', 'deploy/worker/generate-toml.js', 'wrangler.toml.example']) {
    for (const pattern of forbiddenBinding) {
      if (pattern.test(read(file))) failures.push(`Forbidden paid Cloudflare resource in ${file}: ${pattern}`);
    }
  }
  for (const [file, pattern, message] of activeSourceChecks) {
    const content = read(file);
    if (file.endsWith('registry.js')) {
      if (!pattern.test(content)) failures.push(`${message}: ${file}`);
    } else if (file.endsWith('index.js') && /must hide legacy/.test(message)) {
      if (!pattern.test(content)) failures.push(`${message}: ${file}`);
    } else if (pattern.test(content)) failures.push(`${message}: ${file}`);
  }
  for (const file of v3SourceFiles) {
    const content = read(file);
    for (const [pattern, message] of forbiddenV3Patterns) {
      // The registry keeps one explicit R2 reject branch as a defence-in-depth
      // guard. It is verified separately above and must not be treated as a
      // provider-creation path.
      if (file.endsWith('registry.js') && message === 'V3 source creates an R2 provider') continue;
      if (pattern.test(content)) failures.push(`${message}: ${file}`);
    }
  }
  if (!/ZERO_COST_MODE\s*=\s*"true"/.test(read('deploy/worker/wrangler.toml'))) failures.push('ZERO_COST_MODE must default to true');
  if (!/ALLOW_R2\s*=\s*"false"/.test(read('deploy/worker/wrangler.toml'))) failures.push('ALLOW_R2 must default to false');
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = inspectZeroCostFiles();
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log('Zero-Cost resource check passed. No forbidden R2, KV, or paid Cloudflare resource binding was found.');
}
