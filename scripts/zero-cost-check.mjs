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
const forbidden = [/workers_ai/i, /vectorize/i, /browser[_ -]?rendering/i, /\bcontainers\b/i];
export function inspectZeroCostFiles(baseDir = root) {
  const read = file => {
    const absolute = resolve(baseDir, file);
    return existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
  };
  const failures = [];
  for (const [file, pattern, message] of required) {
    if (pattern.test(read(file))) failures.push(`${message}: ${file}`);
  }
  for (const file of ['deploy/worker/wrangler.toml', 'deploy/worker/generate-toml.js']) {
    for (const pattern of forbidden) {
      if (pattern.test(read(file))) failures.push(`Forbidden paid Cloudflare resource in ${file}: ${pattern}`);
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
  console.log('Zero-Cost resource check passed. No R2 binding or paid Cloudflare resource binding was found.');
}
