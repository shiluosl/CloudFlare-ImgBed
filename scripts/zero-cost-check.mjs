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
  console.log('Zero-Cost resource check passed. No R2 binding or paid Cloudflare resource binding was found.');
}
