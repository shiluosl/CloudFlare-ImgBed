import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requestedPath = parseConfigPath(process.argv.slice(2));
const configPath = resolve(root, requestedPath);
const relativePath = relative(root, configPath);
if (!relativePath || relativePath.startsWith('..') || /^(?:[A-Za-z]:)?[\\/]/.test(relativePath)) {
  throw new Error('Deployment configuration must be a repository-relative path');
}
const config = readFileSync(configPath, 'utf8');
const failures = [];

if (!/\[\[d1_databases\]\][\s\S]*?binding\s*=\s*"DB"/m.test(config)) {
  failures.push('V3 deployment requires a D1 binding named DB');
}
if (!/\[\[queues\.producers\]\][\s\S]*?binding\s*=\s*"STORAGE_QUEUE"/m.test(config)) {
  failures.push('V3 deployment requires a Queue producer binding named STORAGE_QUEUE');
}
if (!/\[\[queues\.consumers\]\]/m.test(config)) {
  failures.push('V3 deployment requires a Queue consumer binding');
}
if (/r2_buckets|kv_namespaces|workers_ai|vectorize|browser[_ -]?rendering|\bcontainers\b/i.test(config)) {
  failures.push('Worker configuration contains a forbidden Zero-Cost binding');
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log('Worker deployment bindings validated: DB and STORAGE_QUEUE are configured with no forbidden Zero-Cost bindings.');

function parseConfigPath(args) {
  if (!args.length) return 'deploy/worker/wrangler.toml';
  if (args.length === 2 && args[0] === '--config' && args[1]) return args[1];
  throw new Error('Usage: node scripts/validate-worker-deployment.mjs [--config path/to/wrangler.toml]');
}
