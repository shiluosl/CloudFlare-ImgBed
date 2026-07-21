# Zero-Cost Deployment

## Preconditions

Use a Cloudflare Free account. Do not enable Workers Paid, Cloudflare Images, Stream, AI, Vectorize, Browser Rendering, Containers, or R2. V3 requires only Workers, D1, Queues, static assets, Cache API, and optionally Turnstile.

## Create free resources

```powershell
npx.cmd wrangler d1 create cloudflare-imgbed-zero-cost
npx.cmd wrangler queues create imgbed-storage-zero-cost
```

`deploy/worker/wrangler.toml.example` and the checked-in `deploy/worker/wrangler.toml` are intentionally CI-safe and have no account-specific identifiers. Before a real deployment, set the following shell variables. `npm run deploy:worker` regenerates the active TOML and refuses to deploy unless both V3 bindings are present. The V3 Worker permits only `ASSETS`, `DB`, and `STORAGE_QUEUE` bindings: R2 and KV namespace bindings are rejected.

```powershell
$env:D1_DATABASE_ID = "the-id-returned-by-wrangler-d1-create"
$env:D1_DATABASE_NAME = "cloudflare-imgbed-zero-cost"
$env:STORAGE_QUEUE_NAME = "imgbed-storage-zero-cost"
```

## Configure secrets

Do not put values in D1, `wrangler.toml`, `WORKER_VARS`, or Git. Use interactive secret entry:

```powershell
npx.cmd wrangler secret put MANAGEMENT_PASSWORD --config deploy/worker/wrangler.toml
npx.cmd wrangler secret put WEBDAV_USERNAME --config deploy/worker/wrangler.toml
npx.cmd wrangler secret put WEBDAV_PASSWORD --config deploy/worker/wrangler.toml
npx.cmd wrangler secret put TELEGRAM_BOT_TOKEN --config deploy/worker/wrangler.toml
```

Channel records save only secret reference names, such as `WEBDAV_PASSWORD` or `TELEGRAM_BOT_TOKEN`. `.dev.vars.example` documents local placeholders; `.dev.vars` is ignored.

### Optional S3-compatible backup channel

S3-compatible storage is an optional external channel. It is not Cloudflare R2 and must never be configured as R2. The external provider can charge independently, so review its pricing, egress policy, and quota before enabling it. The V3 Worker continues to use only Workers Free, D1 Free, Queues Free, static assets, Cache API, and optional Turnstile.

Store credentials as Worker secrets, never in the channel configuration:

```powershell
npx.cmd wrangler secret put S3_ACCESS_KEY_ID --config deploy/worker/wrangler.toml
npx.cmd wrangler secret put S3_SECRET_ACCESS_KEY --config deploy/worker/wrangler.toml
```

Create the channel through the authenticated operations API or `/ops.html` with separate configuration and secret-reference objects. Neither object contains credential values:

```json
{
  "config": {
    "endpoint": "https://s3.example.com",
    "bucketName": "imgbed-backups",
    "region": "auto",
    "pathStyle": false
  },
  "secretRefs": {
    "accessKeyIdRef": "S3_ACCESS_KEY_ID",
    "secretAccessKeyRef": "S3_SECRET_ACCESS_KEY"
  }
}
```

The endpoint must be HTTPS, must not embed credentials, and must be publicly reachable. Private, loopback, link-local, CGNAT, and local IPv6 destinations are always rejected; `allowPrivateEndpoint` is not supported. S3 is intended for an asynchronous or explicitly selected backup policy; the stable default remains WebDAV primary plus Telegram synchronous backup.

## Apply migrations

Back up/export D1 before applying production migrations. All V3 migrations are additive and must be applied in numeric order: `0030_zero_cost_dr_v3.sql`, `0031_zero_cost_dr_health_leases.sql`, `0032_zero_cost_dr_maintenance_state.sql`, then `0033_zero_cost_dr_replica_maintenance.sql`.

```powershell
npx.cmd wrangler d1 migrations apply cloudflare-imgbed-zero-cost --local --config deploy/worker/wrangler.toml
npx.cmd wrangler d1 migrations apply cloudflare-imgbed-zero-cost --remote --config deploy/worker/wrangler.toml
```

## Validate and deploy

```powershell
npm.cmd run lint
npm.cmd run check:migrations
npm.cmd run check:secrets
npm.cmd test
npm.cmd run build
npx.cmd wrangler deploy --dry-run --config deploy/worker/wrangler.toml
npm.cmd run deploy:worker
```

## Local development and test deployment

Copy `.dev.vars.example` to a local untracked `.dev.vars`, replacing only the placeholders needed for the channels being tested. Do not use production credentials for local tests. Apply migrations locally, then start the Worker with local D1/Queue simulation:

```powershell
npx.cmd wrangler d1 migrations apply cloudflare-imgbed-zero-cost --local --config deploy/worker/wrangler.toml
npx.cmd wrangler dev --local --config deploy/worker/wrangler.toml --port 8787
```

Use a separate Cloudflare Free account or isolated Free-plan resources for a test deployment. Run the full validation commands above and `npx.cmd wrangler deploy --dry-run --config deploy/worker/wrangler.toml` before `npm.cmd run deploy:worker`. The latter requires operator-supplied D1 and Queue identifiers and is the only command in this guide that performs a real deployment.

Anonymous V3 upload is disabled by default. Before enabling a future anonymous-upload route, create a free Turnstile widget in the Cloudflare dashboard, store its secret with `wrangler secret put TURNSTILE_SECRET`, configure the public site key as a non-secret variable, and require successful server-side verification before `UploadService` is called.

The checked-in cron triggers redispatch of due D1 jobs every 15 minutes. At `NORMAL`, D1-backed cursors rotate bounded light channel checks and low-cost replica `head()` verification without KV or Durable Objects. At `WRITE_LIMITED`, verification remains paused while a separate bounded scan may enqueue only essential primary/synchronous-backup repairs that preserve the last readable copy.

`WORKER_REQUEST_SAMPLE_RATE=100` is enabled by default. The Worker records an estimated 100 requests only for one sampled V3 request, using `cf-ray` when Cloudflare provides it. `D1_READS_PER_SAMPLED_V3_REQUEST=3` adds the bounded estimate for the normal V3 D1 read footprint to that same advisory write. The work runs through `waitUntil`, so public `/file/{fileId}` reads are not turned into a D1 write per request. Set the sample rate to `1` only for short non-production diagnostics; larger values reduce D1 write overhead at the cost of coarser estimates.

The operations panel's database-size field is an intentionally conservative application-metadata estimate. Successful logical uploads add a bounded file-and-replica metadata allowance; it is useful for trend monitoring, but it is not an authoritative D1 storage or billing measurement.

## Free-tier checklist

- `ZERO_COST_MODE=true` and `ALLOW_R2=false` remain set.
- `npm run check:zero-cost` passes.
- Worker bindings contain `ASSETS`, `DB`, and `STORAGE_QUEUE`; no R2 or KV namespace binding exists.
- Create WebDAV and Telegram channels through the authenticated operations API, then create a safe policy with distinct failure domains.
- Keep anonymous V3 upload disabled unless a Turnstile-verified route is added.
- Confirm the Cloudflare account remains on the Free plan and that Workers Paid has not been enabled.
- Confirm the dashboard has no R2 bucket or R2 binding for this Worker; `r2_buckets` must remain absent from all deployment configuration.
- Treat S3-compatible provider billing as an external risk, not a Cloudflare free-tier exception.

## Troubleshooting

- `check:zero-cost` fails: remove prohibited bindings or runtime references, including R2, Workers AI, Vectorize, Browser Rendering, and Containers. The V3 registry intentionally rejects `provider=r2`.
- A channel test reports authentication failure: rotate the provider credential, update the corresponding Worker secret, and keep only the secret reference name in D1.
- A channel test reports an invalid endpoint: use a public HTTPS endpoint without URL credentials; do not point WebDAV or S3 configuration at private or link-local addresses. There is no private-endpoint override, including for self-hosted S3-compatible services.
- The dry run shows no D1/Queue bindings: this is expected for the checked-in identifier-free TOML. Use `npm.cmd run deploy:worker` with operator-provided identifiers to generate and validate a deployment-capable configuration.
- Uploads are refused by the protection guard: inspect `/ops.html`, reduce usage, wait for the next accounting window, and do not resolve the issue by enabling a paid Cloudflare product.
