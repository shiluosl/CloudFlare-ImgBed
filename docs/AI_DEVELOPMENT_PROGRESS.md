# AI Development Progress

## Current phase

Phase 12 and the final capability-contract, SSRF-boundary, read-only fallback-side-effect, protected cron-redispatch, private-endpoint-bypass, checked-in Worker-template scan, V3-authoritative-read, historical-R2-session isolation, atomic-deletion/local-start audit, tombstone/cache-consistency audit, private-read authorization audit, D1 policy-threshold audit, legacy-management R2 configuration audit, CI binding-contract validation, and remote-success/D1-acknowledgement interruption audit are complete on `feature/zero-cost-dr-v3`. The final audit closes deployment-binding, legacy-R2 isolation, legacy-KV deployment and local-start isolation, rollback-flag, management-surface, transition-audit, durable-Queue, upload-state, fair bounded maintenance-scan, silent-replica-loss recovery, sampled usage, rate-paused synchronous-upload preflight, policy-controls, D1-read estimation, metadata-size estimation, optional S3-compatible adapter support, bounded batch upload, fallback auditing, deletion recovery coverage, effective channel capability enforcement, guarded deletion retries, scoped V3 paid-resource scan, tombstone/cache-consistency, default-deny private-file-access, database-level policy-threshold, historical legacy-R2 management, CI deployment-binding, and uncertain-remote-write gaps identified in post-implementation review.

## Completed

- Added additive V3 D1 schema and repositories. Legacy tables and routes are retained.
- Added WebDAV and Telegram adapters behind a common storage adapter contract.
- Added safe, strict, and fast dual-write uploads with idempotency keys.
- Added logical public reads at `/file/{fileId}` with two-replica failover and deferred repair.
- Added D1-backed jobs, Queue wakeups, cron redispatch, tombstone-first deletion, and repair/verify jobs.
- Added zero-cost protection levels, deployment configuration guards, CI checks, and R2 rejection.
- Added authenticated operations APIs and `frontend-dist/ops.html` without replacing the upstream frontend.
- Added `0031_zero_cost_dr_health_leases.sql` for channel recovery counters, rate-limit pauses, and bounded recovery of expired Queue-worker leases.
- Made tombstone insertion generation-aware without replacing an existing tombstone; stale deletion attempts now cannot overwrite deletion history.
- Added recovery transitions for repaired files/replicas, D1 recovery of expired `running` jobs, and explicit guard policies for delete, repair, verification, async copies, and Queue dispatch.
- Removed V3 adapter fallback to plaintext channel credentials, reject external redirects, validate Telegram proxy URLs, and redact remote object metadata from operations APIs.
- Added executable SQLite migration coverage and channel health/circuit-breaker regression tests.
- Split local unit and integration commands. The integration suite directly verifies D1-job/Queue recovery behavior for Queue-send failure, cron redispatch, expired leases, duplicate delivery, and tombstone cancellation.
- Preflight required synchronous channels before file creation, so an already offline/disabled/quota-blocked channel cannot leave an orphaned `receiving` file.
- Defined `available` using the primary plus synchronous backup only; optional async copies cannot mask a missing required replica.
- Added a bounded V3 MIME/extension policy, with environment variables that can narrow the reviewed default set.
- Removed the optional KV namespace binding from the V3 deployment generator and deployment workflow; `KV_NAMESPACE_ID` is now rejected both directly and through `WORKER_VARS`, while CI verifies that generated V3 Workers use only `ASSETS`, D1, and Queue bindings.
- Added `0032_zero_cost_dr_maintenance_state.sql` and a D1-backed rotating health-check cursor. Scheduled maintenance remains bounded to five channels per run but no longer starves channels beyond the first page.
- Normalized malformed management JSON to `400` and Zero Cost Guard mutation rejections to `503` for channel and policy operations, with handler-level regression coverage.
- Added `0033_zero_cost_dr_replica_maintenance.sql`, bounded rotating replica-maintenance and critical-repair cursors, low-cost verification discovery, deterministic `missing`/`corrupt` status transitions, deferred auto-repair jobs, and destination-channel write eligibility checks before repair source reads.
- At `WRITE_LIMITED`, normal verification remains paused while a bounded essential-repair scan may preserve the last readable copy by rebuilding a required primary or synchronous backup only when exactly one healthy source remains.
- Added sampled V3 Worker request estimation (`WORKER_REQUEST_SAMPLE_RATE=100`) through `waitUntil`; it updates the application usage counter without adding a D1 write to every public read.
- Synchronous upload preflight now treats a future channel `blocked_until` as unavailable, preventing rate-limited channels from creating immediately stranded logical files.
- Expanded the operations policy UI/API validation to configure async channels, required/minimum readable copies, automatic repair, and quota-risk writes. Channels and policies now use the same bounded cursor pagination as files, jobs, and audits.
- The deploy workflow now requires generated D1/Queue bindings and runs deployment-binding validation plus a secret scan before invoking Wrangler.
- Enforced `required_copies` and `minimum_readable_copies` as the bounded synchronous health target while preserving a read from the last healthy replica; asynchronous copies cannot make a required synchronous copy healthy.
- Enforced `stop_when_quota_risk` before logical-file creation at every non-`NORMAL` guard level, with a `QUOTA_RISK_POLICY` refusal that leaves no orphaned file.
- Added one-upsert sampled D1-read estimation (`D1_READS_PER_SAMPLED_V3_REQUEST=3`) and bounded upload metadata-size estimates for the zero-cost operations panel.
- Added regression coverage for policy enforcement, nonzero metadata estimates, sampled D1 reads, and a disposable R2-bound Wrangler configuration that must fail the zero-cost scanner.
- Added `0034_zero_cost_dr_policy_copy_bounds.sql`: it normalizes early V3 policy rows and uses D1 triggers to enforce the one-to-two synchronous-copy ceiling and `minimum_readable_copies <= required_copies`, including executable migration regression coverage.
- Added an optional S3-compatible adapter behind the common `put/get/head/delete/healthCheck` contract, using streamed bodies, bounded timeout, endpoint validation, secret-reference-only credentials, normalized errors, and no provider URL output.
- Added authenticated S3 channel validation, secret redaction, and an operations-panel warning for independent external provider costs. Cloudflare R2 remains rejected in every V3 path.
- Added sequential support for up to five multipart V3 files per request using bounded derived idempotency keys; one-file requests retain their existing response envelope and status behavior.
- Added `file.readFallback` audit logging only when a backup read succeeds, plus a deletion-recovery integration case that reaches `delete_degraded` then finalizes after retry.
- Extended the zero-cost scanner with V3 source checks for forbidden R2 runtime access/provider creation and prohibited paid Cloudflare features, with a disposable-source regression test.
- Added effective channel capability calculation: persisted capabilities can only disable an Adapter operation or lower its object-size ceiling. Policy validation and upload preflight now reject selected channels without read/write/delete support before creating a logical file. Operations UI displays the effective contract rather than untrusted raw channel metadata.
- Retrying a deletion job now follows the same Zero Cost Guard delete rule as initial deletion. Endpoint validation also rejects CGNAT and IPv4-mapped IPv6 targets to tighten SSRF protection.
- A `READ_ONLY` or `EMERGENCY` fallback read now remains side-effect-free: it can stream a healthy backup but does not update channel health, mark the primary suspect, create ordinary repair work, or write a fallback audit record. These optional actions resume only when ordinary repair is permitted.
- `RECOUNT_FILE_HEALTH` and `RECONCILE_FILE` are now treated as ordinary Guarded D1 writes during Queue execution and manual retry; the consumer defers them when write protection is active instead of silently changing file state.
- Queue consumers now evaluate the operation-specific Zero Cost Guard using a read-only durable-job lookup before `claimJob()`. Guard-paused delayed messages are acknowledged without changing job status, consuming an attempt, or calling an Adapter; the existing post-claim check remains race protection. `READ_ONLY` continues to permit tombstoned deletion, while `EMERGENCY` pauses it before claim.
- Cron now obtains the Zero Cost Guard level before recovering expired leases. `READ_ONLY` recovers and redispatches only tombstoned deletion jobs; `WRITE_LIMITED` additionally permits only degraded/failed required-replica repair with exactly one readable copy; `EMERGENCY` performs no job recovery or Queue dispatch. Recovery updates target an approved job-ID set, so paused ordinary work remains untouched.
- Removed the `allowPrivateEndpoint` escape hatch. The operations API rejects it, endpoint validation has no private-address override, and WebDAV/S3 adapters reject private legacy channel records at runtime. Regression coverage verifies both the management and Adapter paths.
- Added the requested identifier-free `deploy/worker/wrangler.toml.example`; it preserves Zero-Cost defaults and intentionally contains no D1, Queue, R2, KV, or Secret values.
- Extended the Zero-Cost scanner to cover every checked-in Worker template, including `deploy/worker/wrangler.toml.example`; a disposable-template regression test proves a future R2 binding in that real deployment template fails CI.
- V3 file reads now remain authoritative once `files_v3` contains the requested ID. Unexpected V3 lookup or service failures return a sanitized `503`; only a missing record, missing D1 binding, or missing V3 migration can reach the legacy route.
- Zero-Cost mode now removes historical `cfr2` channels from the legacy channel API, rejects direct legacy R2 uploads, rejects persisted R2 chunk sessions during continuation and merge, and removes R2 from legacy automatic retry candidates. This extends the existing Worker query gate to the session-backed paths it cannot inspect.
- Deletion initialization now persists the file state, generation-aware tombstone, replica `deleting` transitions, idempotent durable deletion jobs, and audit event in one D1 batch before any Queue wake-up. Concurrent delete requests converge safely on the original tombstone.
- Telegram treats a remotely absent message as an already successful deletion, channel-list serialization tolerates malformed historical JSON, and synchronous upload maps each replica by channel ID rather than query order.
- `npm start` now launches the generated zero-cost Worker with ignored local D1/Queue simulation on port 8080 and no KV/R2 binding; CI rejects a local start script that declares `--kv`.
- V3 logical-file reads now bypass shared Worker Cache API and return `Cache-Control: private, no-store`, so a committed tombstone cannot be bypassed by a stale per-PoP cache entry. Cache API remains limited to non-V3 temporary responses.
- V3 private logical files now use default-deny authorization before `FileService`: a configured user auth code, configured administrator session, or validated API token is required. The historical compatibility behavior that treats an unconfigured user auth code as authorized is never used to expose a V3 private file, and failed authorization returns a non-enumerating `404`.
- Zero-Cost legacy management GET requests now return an empty compatibility `cfr2` shape, hide the R2 default-channel option, and clear a persisted R2 default. Legacy management POST requests reject non-empty R2 channel configuration and R2 default selection with `400`, without changing historical KV data.
- Storage channel operations now allow administrators to update only the non-sensitive `failureDomain` and `priority` fields. The repository enforces this write whitelist, the API validates bounded values behind `assertWrite({ admin: true })`, and `channel.updated` audit records contain only the changed operational metadata.
- CI now validates the checked-in placeholder deployment contract (`wrangler.toml.example`) for `DB` and `STORAGE_QUEUE` bindings before its identifier-free Wrangler dry run. The validator accepts only repository-relative TOML paths, so CI cannot accidentally read a local credential-bearing configuration.
- Added an integration regression for a remote write that succeeds before the D1 healthy-state acknowledgement. The durable job becomes retryable and never reports a healthy replica until D1 accepts the update. WebDAV/S3 retries converge on deterministic object keys; Telegram's unavoidable untracked-message limitation is explicitly documented without introducing a prohibited history scan.

## Not completed / deliberate limits

- Real WebDAV and Telegram end-to-end tests require operator-owned credentials and were not run.
- Hugging Face and Discord V3 adapters are deferred until their provider contracts can receive the same isolated adapter and mock-contract treatment. S3-compatible storage is implemented as an optional external channel; its billing is outside the Cloudflare zero-cost guarantee.
- Anonymous V3 upload is implemented at `POST /api/upload/v3`, but remains default-disabled. When explicitly enabled, it requires successful server-side Turnstile verification before runtime construction, forces public `safe` inputs, strips caller-controlled ownership and visibility fields, and still uses `UploadService` for Zero Cost Guard, validation, dual-write, and auditing.
- Usage counters are conservative application estimates, not a substitute for Cloudflare billing telemetry.

## Latest code state

- Branch: `feature/zero-cost-dr-v3`
- Latest upstream baseline commit before this work: `07fe250`
- Final hardening verification passed on 2026-07-21:
  - `node deploy/worker/generate-routes.js`
  - `node scripts/zero-cost-check.mjs`
  - Final reconciliation verification on 2026-07-21: `npm.cmd test` - 28 unit tests and 4 integration tests passing; `npm.cmd run lint`, `npm.cmd run check:migrations`, `npm.cmd run check:secrets`, `npm.cmd run build`, and binding-free `npx.cmd wrangler deploy --dry-run --config deploy/worker/wrangler.toml` all passed
  - `npm.cmd run lint`
  - `npm.cmd run check:migrations`
  - `npm.cmd run check:secrets`
  - `npm.cmd run build` - 52 routes, 9 catch-all routes
  - `frontend-dist/ops.html` inline JavaScript syntax validation
  - Final policy and estimate audit on 2026-07-21: `npm.cmd test` - 33 unit tests and 4 integration tests passing; `npm.cmd run lint`, `npm.cmd run check:migrations`, `npm.cmd run check:secrets`, `npm.cmd run build`, and binding-free `npx.cmd wrangler deploy --dry-run --config deploy/worker/wrangler.toml` all passed. The dry run reported only `ASSETS` plus zero-cost environment variables and no D1/Queue bindings because the checked-in TOML remains intentionally identifier-free.
  - Final S3/batch/failover audit on 2026-07-21: `npm.cmd test` - 37 unit tests and 5 integration tests passing; `npm.cmd run lint`, `npm.cmd run check:migrations`, `npm.cmd run check:secrets`, `npm.cmd run build`, and binding-free `npx.cmd wrangler deploy --dry-run --config deploy/worker/wrangler.toml` all passed. The dry run reported only `ASSETS` plus zero-cost environment variables and no D1/Queue bindings because the checked-in TOML remains intentionally identifier-free.
  - Final capability-contract/SSRF audit on 2026-07-21: `npm.cmd test` - 41 unit tests and 5 integration tests passing; `npm.cmd run lint`, `npm.cmd run check:migrations`, `npm.cmd run check:secrets`, `npm.cmd run build`, and binding-free `npx.cmd wrangler deploy --dry-run --config deploy/worker/wrangler.toml` all passed. `git diff --check` and inline JavaScript syntax validation for `frontend-dist/ops.html` also passed. Real WebDAV, Telegram, and S3-compatible end-to-end tests remain intentionally unrun because no external credentials were used.
  - Final read-only write-protection audit on 2026-07-21: `npm.cmd test` - 43 unit tests and 6 integration tests passing; `npm.cmd run lint`, `npm.cmd run check:migrations`, `npm.cmd run check:secrets`, `npm.cmd run build`, binding-free `npx.cmd wrangler deploy --dry-run --config deploy/worker/wrangler.toml`, and `git diff --check` all passed. The dry run reported only `ASSETS` and zero-cost environment variables.
  - Final protected-cron audit on 2026-07-21: `npm.cmd test` - 43 unit tests and 9 integration tests passing; `npm.cmd run lint`, `npm.cmd run check:migrations`, `npm.cmd run check:secrets`, `npm.cmd run build`, binding-free `npx.cmd wrangler deploy --dry-run --config deploy/worker/wrangler.toml`, and `git diff --check` all passed. The dry run reported only `ASSETS` and zero-cost environment variables.
  - Final private-endpoint audit on 2026-07-21: `npm.cmd test` - 44 unit tests and 9 integration tests passing; `npm.cmd run lint`, `npm.cmd run check:migrations`, `npm.cmd run check:secrets`, `npm.cmd run build`, binding-free `npx.cmd wrangler deploy --dry-run --config deploy/worker/wrangler.toml`, and `git diff --check` all passed. Public storage endpoints must now use HTTPS, and neither new nor legacy configuration can permit a private-network target.
  - Final Worker-template scan audit on 2026-07-21: `npm.cmd test` - 45 unit tests and 9 integration tests passing; `npm.cmd run lint`, `npm.cmd run check:migrations`, `npm.cmd run check:secrets`, `npm.cmd run build`, binding-free `npx.cmd wrangler deploy --dry-run --config deploy/worker/wrangler.toml`, and `git diff --check` all passed. The scanner now checks `deploy/worker/wrangler.toml.example` for R2, KV, Workers AI, Vectorize, Browser Rendering, Containers, and zero-cost defaults in addition to the active configuration.
  - Final V3-authoritative-read and legacy-R2-session audit on 2026-07-21: `npm.cmd test` passed with 47 unit tests and 9 integration tests; `npm.cmd run lint`, `npm.cmd run check:migrations`, `npm.cmd run check:secrets`, `npm.cmd run build`, binding-free `npx.cmd wrangler deploy --dry-run --config deploy/worker/wrangler.toml`, and `git diff --check` all passed. The generated Worker has 52 routes (9 catch-all); dry-run reported only `ASSETS` and the expected zero-cost environment variables, with no D1, Queue, KV, or R2 bindings. The provider tests remain mock/contract tests; no external WebDAV, Telegram, or S3-compatible credentials were used.
  - Final atomic-deletion/local-start audit on 2026-07-21: `npm.cmd test` passed with 51 unit tests and 9 integration tests; `npm.cmd run lint`, `npm.cmd run check:migrations`, `npm.cmd run check:secrets`, `npm.cmd run build`, binding-free `npx.cmd wrangler deploy --dry-run --config deploy/worker/wrangler.toml`, and `git diff --check` all passed. `npm.cmd start` also built the project, launched the local zero-cost Worker, and served `http://localhost:8080/` with HTTP 200. The generated Worker has 52 routes (9 catch-all); dry-run reported only `ASSETS` and zero-cost variables. No external WebDAV, Telegram, or S3-compatible credentials were used.
  - Final tombstone/cache-consistency audit on 2026-07-21: `npm.cmd test` passed with 52 unit tests and 9 integration tests. `npm.cmd run lint`, `npm.cmd run check:migrations`, `npm.cmd run check:secrets`, `npm.cmd run build`, binding-free `npx.cmd wrangler deploy --dry-run --config deploy/worker/wrangler.toml`, and `git diff --check` passed. The generated Worker has 52 routes (9 catch-all); dry-run reported only `ASSETS` and zero-cost variables. No external WebDAV, Telegram, or S3-compatible credentials were used.
- Anonymous-upload/Turnstile implementation verification on 2026-07-21: `npm.cmd run test:unit` passed with 58 tests and `npm.cmd run test:integration` passed with 9 tests. `npm.cmd run check:migrations`, `npm.cmd run lint`, `npm.cmd run check:secrets`, `npm.cmd run build`, binding-free `npx.cmd wrangler deploy --dry-run --config deploy/worker/wrangler.toml`, and `git diff --check` passed. The generated Worker has 53 routes (9 catch-all), including a public middleware-only `POST /api/upload/v3` route. The dry run exposed only `ASSETS` and zero-cost environment variables, with no R2, KV, D1, or Queue binding. No external provider credentials were used.
  - Final D1 policy-threshold audit on 2026-07-21: `npm.cmd test` passed with 59 unit tests and 9 integration tests; `npm.cmd run lint`, `npm.cmd run check:migrations`, `npm.cmd run check:secrets`, `npm.cmd run build`, `npx.cmd wrangler deploy --dry-run --config deploy/worker/wrangler.toml`, and `git diff --check` passed. Migration `0034` has executable upgrade and trigger enforcement coverage. The checked-in Worker TOML remains zero-cost and contains no R2 or KV binding; no production deployment or external provider credential test was performed.
  - Final Queue pre-claim guard audit on 2026-07-21: `npm.cmd test` passed with 59 unit tests and 11 integration tests; `npm.cmd run lint`, `npm.cmd run check:migrations`, `npm.cmd run check:secrets`, `npm.cmd run build`, binding-free `npx.cmd wrangler deploy --dry-run --config deploy/worker/wrangler.toml`, and `git diff --check` passed. The integration coverage proves that `READ_ONLY` and `EMERGENCY` Queue deliveries are acknowledged before `claimJob()` can increment attempts or call external storage, while tombstoned deletion remains executable in `READ_ONLY`. The dry run exposed only `ASSETS` and zero-cost environment variables, without R2, KV, D1, or Queue identifiers.
- Final legacy-management R2 audit on 2026-07-21: `npm.cmd test` passed with 60 unit tests and 11 integration tests; `npm.cmd run lint`, `npm.cmd run check:migrations`, `npm.cmd run check:secrets`, `npm.cmd run build`, and binding-free `npx.cmd wrangler deploy --dry-run --config deploy/worker/wrangler.toml` passed. The dry run reported only `ASSETS` and Zero-Cost environment variables; no R2, KV, D1, Queue, or paid Cloudflare binding was present. No external provider credentials were used.
  - Final channel-priority/failure-domain management audit on 2026-07-21: `npm.cmd test` passed with 63 unit tests and 11 integration tests. `npm.cmd run lint`, `npm.cmd run check:migrations`, `npm.cmd run check:secrets`, `npm.cmd run build`, the operations-page inline JavaScript syntax check, `npx.cmd wrangler deploy --dry-run --config deploy/worker/wrangler.toml`, and `git diff --check` passed. The dry run listed only `ASSETS` and Zero-Cost environment variables, without D1/Queue identifiers, KV, R2, or paid Cloudflare bindings.

## Commits created

- `85c3b17` `chore(repo): prepare zero-cost dr development baseline`
- `f5a6280` `feat(db): add storage replica schema and repositories`
- `7e6460d` `feat(storage): add common storage adapter contract`
- `d60d579` `feat(storage): implement WebDAV adapter`
- `3a6fc38` `feat(storage): implement Telegram adapter`
- `7e730eb` `feat(upload): add idempotent dual-write upload`
- `0b11745` `feat(queue): add persistent outbox and replication consumer`
- `c9976a4` `feat(read): add transparent replica failover`
- `79bd7d6` `feat(cost): add zero-cost usage guard`
- `6ffa4ec` `feat(admin): add storage operations dashboard`
- `21ca4e6` `test(dr): add disaster recovery integration tests`
- `7877ba3` `chore(ci): enforce zero-cost deployment checks`
- `5855321` `fix(deploy): require D1 and Queue bindings for V3 worker`
- `0cf5790` `fix(core): harden V3 rollback and state auditing`
- `d661fa4` `feat(admin): expand zero-cost storage operations`
- Latest: `test(dr): harden required replica semantics and queue recovery coverage` (see Git history for the immutable commit ID).
- Latest deployment-isolation patch: `fix(deploy): exclude KV from zero-cost V3 Worker bindings` (see Git history for the immutable commit ID).
- Latest operations hardening patch: `b6a0c51` `fix(ops): rotate bounded health checks and normalize management errors`.
- Latest reconciliation patch: `feat(repair): add bounded replica reconciliation`.
- Final follow-up change set: sampled Worker/D1-read usage, bounded metadata estimates, policy health/quota enforcement, rate-paused upload preflight, complete policy operations controls, and pre-deploy binding validation.
- Latest S3/coverage patch: `e371224` `feat(storage): add optional S3-compatible DR adapter`.
- Final capability-contract/SSRF implementation: `d7d5448` `fix(storage): enforce channel capability contracts`. It adds effective capability enforcement, configured per-channel object-size limits, guarded deletion retries, and expanded private-endpoint rejection; regression verification passed.
- Latest V3-authoritative-read and legacy-R2-session patch: `fix(zero-cost): isolate v3 reads and legacy r2 paths`.
- Latest final-audit commit: `fix(delete): atomically persist tombstones and deletion work`. It includes idempotent Telegram absence handling, robust channel serialization, channel-ID upload mapping, and no-KV local Worker startup.
- Latest tombstone/cache-consistency commit: `eefcc6a` `fix(read): prevent cached reads after tombstone deletion`. It bypasses shared Worker Cache API for V3 logical-file routes and returns `private, no-store`, so a D1 tombstone cannot be bypassed by a stale per-PoP cache entry.
- Latest D1 policy-boundary hardening: `fix(db): enforce synchronous replica policy bounds`. It adds migration `0034`, normalizes historical three-copy thresholds, blocks invalid direct D1 inserts/updates with triggers, and updates deployment/recovery instructions.
- Latest legacy-management R2 isolation: `e7ac02c` `fix(zero-cost): hide legacy r2 management controls`. It prevents Zero-Cost management reads from exposing historical R2 configuration/defaults and rejects attempts to persist or select R2 through legacy management APIs.
- Channel metadata edits are intentionally limited to failure domain and read priority, preserving the prohibition on changing provider configuration or Secret references through this operations action.

## Key decisions

- D1 is the durable task source of truth; Queue messages contain only identifiers.
- Tombstones advance the file generation and prevent late create/repair work from reviving a deleted file.
- R2 is prohibited in the checked-in Worker config, deployment generator, V3 adapter registry, and CI scanner.
- The checked-in deployment TOML is deliberately binding-free so it is safe for source control and static dry-runs. The real deployment command generates a short-lived binding configuration from operator-provided identifiers and validates it before Wrangler runs.

## Compatibility adjustments

- The upstream repository has compiled static frontend assets but no practical frontend source tree. V3 therefore adds the independent authenticated `frontend-dist/ops.html` operations surface and leaves the existing frontend untouched.
- Existing upstream R2 routes and storage code remain unmodified for backward compatibility, but V3 configuration, management APIs, adapter registry, startup command, deployment generator, and CI reject R2. Operators must not enable legacy R2 paths in a zero-cost deployment.
- The final audit adds handler-level enforcement for legacy R2 uploads and session continuations, because a generated Worker can inspect an incoming query but cannot infer a stored upload channel without entering the route handler.
- Read fallback, tombstone deletion, and verification/repair execution share `FileService` and the Queue consumer rather than being split into artificial files. The route-to-service-to-orchestrator-to-adapter boundary remains intact.
- The requested S3-compatible option is implemented only as an external adapter. It has no Cloudflare R2 relation and the default stable synchronous pair remains WebDAV plus Telegram.

## Next actions

1. Apply `0030_zero_cost_dr_v3.sql` through `0034_zero_cost_dr_policy_copy_bounds.sql` in order to an operator-owned D1 database before a real deployment.
2. Configure dedicated non-production WebDAV, Telegram, and optional S3-compatible credentials before external end-to-end tests.

## Known limits

- The current test suite is local and mock-backed for external providers. No real WebDAV, Telegram, or S3-compatible credentials were used.
- Legacy upstream R2 implementation files remain for compatibility, but the zero-cost Worker configuration contains no R2 binding and the V3 adapter/API paths reject R2.
- Historical R2 KV records remain for non-zero-cost compatibility, but Zero-Cost management reads cannot expose or select them and management writes cannot reactivate them.
- The static `wrangler deploy --dry-run` uses the binding-free checked-in TOML; it validates generated Worker syntax and configuration only. A deployment-capable configuration is generated only by `npm run deploy:worker` with `D1_DATABASE_ID` and `STORAGE_QUEUE_NAME` supplied by the operator.
- CI additionally validates `wrangler.toml.example` as the identifier-free D1/Queue binding contract. It does not deploy or contact a Cloudflare account.
- The upstream operations page is intentionally extended rather than redesigned; advanced bulk operations and provider-specific telemetry remain bounded by free-tier limits.
- S3-compatible provider pricing, egress, availability, and API limits are external operator risks and are not covered by Cloudflare's zero-cost boundary.
- Telegram `sendDocument` has no caller-selected object key or searchable idempotency token. A Worker interruption after remote acceptance and before D1 acknowledgement may leave an untracked Telegram message. Logical-file state remains safe and retryable; narrow operator cleanup is documented, while bulk chat-history scans remain forbidden.
