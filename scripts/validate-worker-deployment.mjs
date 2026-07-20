import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const configPath = resolve('deploy/worker/wrangler.toml');
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
