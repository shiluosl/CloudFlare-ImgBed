import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

// Keep local development on the same Worker surface as deployment without a KV binding.
mkdirSync('.wrangler', { recursive: true });
writeFileSync('.wrangler/zero-cost-dev.toml', `name = "cloudflare-imgbed-zero-cost-local"
main = "../deploy/worker/index.js"
compatibility_date = "2026-07-01"
compatibility_flags = ["global_fetch_strictly_public", "nodejs_compat"]

[assets]
directory = "../frontend-dist"
binding = "ASSETS"
not_found_handling = "single-page-application"

[vars]
ZERO_COST_MODE = "true"
ALLOW_R2 = "false"
ENABLE_REPLICATION_V3 = "true"
ENABLE_V3_UPLOAD = "true"
ENABLE_V3_READ = "true"

[[d1_databases]]
binding = "DB"
database_name = "cloudflare-imgbed-zero-cost-local"
database_id = "00000000-0000-0000-0000-000000000000"
migrations_dir = "../database/migrations"

[[queues.producers]]
binding = "STORAGE_QUEUE"
queue = "cloudflare-imgbed-zero-cost-local"

[[queues.consumers]]
queue = "cloudflare-imgbed-zero-cost-local"
max_batch_size = 5
max_batch_timeout = 5

[triggers]
crons = ["*/15 * * * *"]
`, 'utf8');

const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
const child = spawn(process.execPath, [wrangler, 'dev', '--config', '.wrangler/zero-cost-dev.toml', '--local', '--ip', '0.0.0.0', '--port', '8080', '--persist-to', './data'], { stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 1));
