/**
 * Generates the Worker deployment configuration from CI-safe environment values.
 * The zero-cost invariants are emitted here and cannot be overridden by WORKER_VARS.
 */
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = join(__dirname, 'wrangler.toml');
const env = process.env;
const name = env.WORKER_NAME || 'cloudflare-imgbed';
const requireBindings = process.argv.includes('--require-bindings') || env.REQUIRE_STORAGE_BINDINGS === 'true';

if (Object.keys(env).some(key => /(^|_)R2(_|$)|WORKERS_AI|VECTORIZ|BROWSER.*RENDER|CONTAINERS|KV_NAMESPACE_ID/i.test(key))) {
  throw new Error('A forbidden Cloudflare resource setting is present in the Zero-Cost deployment generator');
}

const extraVars = parseWorkerVars(env.WORKER_VARS);
const extraVarToml = Object.entries(extraVars).map(([key, value]) => `${key} = "${escapeToml(value)}"`).join('\n');

let toml = `name = "${escapeToml(name)}"
main = "index.js"
compatibility_date = "2026-07-01"
compatibility_flags = ["global_fetch_strictly_public", "nodejs_compat"]

[assets]
directory = "../../frontend-dist"
binding = "ASSETS"
not_found_handling = "single-page-application"

[vars]
ZERO_COST_MODE = "true"
ALLOW_R2 = "false"
ENABLE_REPLICATION_V3 = "true"
ENABLE_V3_UPLOAD = "true"
ENABLE_V3_READ = "true"
MAX_UPLOAD_BYTES = "10485760"
HARD_MAX_UPLOAD_BYTES = "20971520"
MAX_SYNC_CHANNELS = "2"
DAILY_UPLOAD_SOFT_LIMIT = "500"
WORKER_REQUEST_SOFT_LIMIT = "80000"
WORKER_REQUEST_SAMPLE_RATE = "100"
D1_READ_SOFT_LIMIT = "3000000"
D1_WRITE_SOFT_LIMIT = "60000"
QUEUE_OPS_SOFT_LIMIT = "7000"
${extraVarToml}
`;

const hasD1Binding = Boolean(env.D1_DATABASE_ID);
const hasQueueBinding = Boolean(env.STORAGE_QUEUE_NAME);
if (requireBindings && (!hasD1Binding || !hasQueueBinding)) {
  throw new Error('D1_DATABASE_ID and STORAGE_QUEUE_NAME are required for a V3 Worker deployment');
}

if (hasD1Binding) {
  toml += `
[[d1_databases]]
binding = "DB"
database_name = "${escapeToml(env.D1_DATABASE_NAME || 'cloudflare-imgbed-zero-cost')}"
database_id = "${escapeToml(env.D1_DATABASE_ID)}"
migrations_dir = "../../database/migrations"
`;
}

if (hasQueueBinding) {
  const queue = escapeToml(env.STORAGE_QUEUE_NAME);
  toml += `
[[queues.producers]]
binding = "STORAGE_QUEUE"
queue = "${queue}"

[[queues.consumers]]
queue = "${queue}"
max_batch_size = 5
max_batch_timeout = 5
`;
}

toml += `
[triggers]
crons = ["*/15 * * * *", "15 */6 * * *"]
`;

writeFileSync(outputPath, toml, 'utf8');
const safeToml = toml
  .replace(/database_id = ".*"/g, 'database_id = "***"')
  .replace(/(id = )".*"/g, '$1"***"')
  .replace(/((?:TOKEN|KEY|SECRET|PASSWORD).*?= )".*"/gi, '$1"***"');
console.log('Generated deploy/worker/wrangler.toml:');
console.log(safeToml);

function escapeToml(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function parseWorkerVars(raw) {
  if (!raw) return {};
  try {
    const vars = JSON.parse(raw);
    for (const key of Object.keys(vars)) {
      if (['ZERO_COST_MODE', 'ALLOW_R2'].includes(key)) continue;
      if (/(^|_)R2(_|$)|WORKERS_AI|VECTORIZ|BROWSER.*RENDER|CONTAINERS|KV_NAMESPACE_ID/i.test(key)) {
        throw new Error(`WORKER_VARS contains forbidden key ${key}`);
      }
    }
    return Object.fromEntries(Object.entries(vars).filter(([key]) => !['ZERO_COST_MODE', 'ALLOW_R2'].includes(key)));
  } catch (error) {
    throw new Error(`WORKER_VARS is invalid: ${error.message}`);
  }
}
