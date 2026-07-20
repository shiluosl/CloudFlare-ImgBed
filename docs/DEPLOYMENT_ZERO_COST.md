# Zero-Cost Deployment

## Preconditions

Use a Cloudflare Free account. Do not enable Workers Paid, Cloudflare Images, Stream, AI, Vectorize, Browser Rendering, Containers, or R2. V3 requires only Workers, D1, Queues, static assets, Cache API, and optionally Turnstile.

## Create free resources

```powershell
npx.cmd wrangler d1 create cloudflare-imgbed-zero-cost
npx.cmd wrangler queues create imgbed-storage-zero-cost
```

Copy `wrangler.toml.example` values into the generated deployment configuration or set `D1_DATABASE_ID` and `STORAGE_QUEUE_NAME` for `deploy/worker/generate-toml.js`. There must be no R2 binding.

## Configure secrets

Do not put values in D1, `wrangler.toml`, `WORKER_VARS`, or Git. Use interactive secret entry:

```powershell
npx.cmd wrangler secret put MANAGEMENT_PASSWORD --config deploy/worker/wrangler.toml
npx.cmd wrangler secret put WEBDAV_USERNAME --config deploy/worker/wrangler.toml
npx.cmd wrangler secret put WEBDAV_PASSWORD --config deploy/worker/wrangler.toml
npx.cmd wrangler secret put TELEGRAM_BOT_TOKEN --config deploy/worker/wrangler.toml
```

Channel records save only secret reference names, such as `WEBDAV_PASSWORD` or `TELEGRAM_BOT_TOKEN`. `.dev.vars.example` documents local placeholders; `.dev.vars` is ignored.

## Apply migrations

Back up/export D1 before applying production migrations. V3 migration `0030_zero_cost_dr_v3.sql` is additive.

```powershell
npx.cmd wrangler d1 migrations apply cloudflare-imgbed-zero-cost --local --config deploy/worker/wrangler.toml
npx.cmd wrangler d1 migrations apply cloudflare-imgbed-zero-cost --remote --config deploy/worker/wrangler.toml
```

## Validate and deploy

```powershell
npm.cmd ci
npm.cmd run lint
npm.cmd run check:migrations
npm.cmd run check:secrets
npm.cmd test
npm.cmd run build
npx.cmd wrangler deploy --dry-run --config deploy/worker/wrangler.toml
npx.cmd wrangler deploy --config deploy/worker/wrangler.toml
```

The checked-in cron triggers redispatch due D1 jobs every 15 minutes and perform bounded light channel health checks only while protection is `NORMAL`.

## Free-tier checklist

- `ZERO_COST_MODE=true` and `ALLOW_R2=false` remain set.
- `npm run check:zero-cost` passes.
- Worker bindings contain `ASSETS`, `DB`, and optionally `STORAGE_QUEUE`; no R2 binding exists.
- Create WebDAV and Telegram channels through the authenticated operations API, then create a safe policy with distinct failure domains.
- Keep anonymous V3 upload disabled unless a Turnstile-verified route is added.
