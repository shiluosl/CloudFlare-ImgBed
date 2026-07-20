# AI Development Progress

## Current phase

Hardening follow-up is in progress on the existing Phase 12 branch. The original V3 milestones are implemented, and the current follow-up closes data-consistency, guard-policy, endpoint-security, and migration-test gaps identified in a post-implementation audit.

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

## Not completed / deliberate limits

- Real WebDAV and Telegram end-to-end tests require operator-owned credentials and were not run.
- S3-compatible, Hugging Face, and Discord V3 adapters are not implemented; registry intentionally supports only WebDAV and Telegram.
- Anonymous V3 upload remains disabled. A future endpoint must validate Turnstile before calling `UploadService`.
- Usage counters are conservative application estimates, not a substitute for Cloudflare billing telemetry.

## Latest code state

- Branch: `feature/zero-cost-dr-v3`
- Latest upstream baseline commit before this work: `07fe250`
 - Latest hardening verification passed on 2026-07-21:
  - `npm.cmd test` - 17 passing, including executable V3 migration coverage
  - `npm.cmd run lint`
  - `npm.cmd run check:migrations`
  - `npm.cmd run check:secrets`
  - `npm.cmd run build` - 52 routes, 9 catch-all routes
  - `npx.cmd wrangler deploy --dry-run --config deploy/worker/wrangler.toml`
  - `git diff --check`

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

## Key decisions

- D1 is the durable task source of truth; Queue messages contain only identifiers.
- Tombstones advance the file generation and prevent late create/repair work from reviving a deleted file.
- R2 is prohibited in the checked-in Worker config, deployment generator, V3 adapter registry, and CI scanner.

## Compatibility adjustments

- The upstream repository has compiled static frontend assets but no practical frontend source tree. V3 therefore adds the independent authenticated `frontend-dist/ops.html` operations surface and leaves the existing frontend untouched.
- Existing upstream R2 routes and storage code remain unmodified for backward compatibility, but V3 configuration, management APIs, adapter registry, startup command, deployment generator, and CI reject R2. Operators must not enable legacy R2 paths in a zero-cost deployment.
- Read fallback, tombstone deletion, and verification/repair execution share `FileService` and the Queue consumer rather than being split into artificial files. The route-to-service-to-orchestrator-to-adapter boundary remains intact.

## Next actions

1. Commit and push the hardening changes on `feature/zero-cost-dr-v3`.
2. Apply `0030_zero_cost_dr_v3.sql` and then `0031_zero_cost_dr_health_leases.sql` to an operator-owned D1 database.
3. Configure dedicated non-production WebDAV and Telegram credentials before external end-to-end tests.

## Known limits

- The current test suite is local and mock-backed for external providers. No real WebDAV or Telegram credentials were used.
- Legacy upstream R2 implementation files remain for compatibility, but the zero-cost Worker configuration contains no R2 binding and the V3 adapter/API paths reject R2.
- The upstream operations page is intentionally extended rather than redesigned; advanced bulk operations and provider-specific telemetry remain bounded by free-tier limits.
