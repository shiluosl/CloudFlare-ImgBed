import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const migrationsDir = resolve('database/migrations');
const requiredTables = ['storage_channels', 'storage_policies', 'files_v3', 'file_replicas', 'storage_jobs', 'file_tombstones', 'usage_counters', 'audit_logs'];
const files = readdirSync(migrationsDir).filter(file => /^\d+_.+\.sql$/.test(file)).sort();
const failures = [];

for (const file of files) {
  const sql = readFileSync(join(migrationsDir, file), 'utf8');
  if (/\bDROP\s+TABLE\b/i.test(sql)) failures.push(`${file} contains DROP TABLE; use an additive migration instead`);
}

const v3 = files.find(file => file.endsWith('_zero_cost_dr_v3.sql'));
if (!v3) failures.push('Missing zero-cost V3 migration');
else {
  const sql = readFileSync(join(migrationsDir, v3), 'utf8');
  for (const table of requiredTables) if (!new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'i').test(sql)) failures.push(`${v3} is missing ${table}`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`Migration check passed for ${files.length} migration files.`);
