# Testing Guide

## Local checks

```powershell
npm.cmd run test:unit
npm.cmd run test:integration
npm.cmd test
npm.cmd run lint
npm.cmd run check:migrations
npm.cmd run check:secrets
npm.cmd run build
npx.cmd wrangler deploy --dry-run --config deploy/worker/wrangler.toml
```

The unit suite uses mocked WebDAV, Telegram, S3-compatible, and Turnstile endpoints plus executable local SQLite coverage for the V3 migration files. The separate integration suite exercises `JobService` and the Queue consumer together using a local durable-job model: Queue-send failure followed by cron redispatch, expired leases, duplicate delivery, pre-claim read-only and emergency Guard pauses, read-only tombstoned deletion, tombstone/generation cancellation, and delete degradation followed by successful recovery. Together they cover dual-write success and degraded outcomes, strict and fast modes, idempotency, bounded five-file request parsing, MIME/extension policy enforcement, policy copy-threshold health, quota-risk upload pausing, disabled and Turnstile-gated anonymous V3 upload with caller-controlled ownership/privacy/mode/file-ID stripping, read failover with an audit record, private V3 default-deny authorization, verification failure repair scheduling, atomic tombstone/delete-job initialization before Queue wake-up, Telegram missing-message deletion, read-only protection, sampled Worker/D1-read accounting, rate-paused upload preflight, endpoint validation, redirect rejection, channel circuit-breaker states, bounded channel/replica maintenance rotation, `WRITE_LIMITED` essential repair scheduling, malformed management JSON, Zero Cost Guard management rejections, clean and deliberately R2-bound deployment/source scanning including a forbidden local `--kv` start command, migration execution, and Zero-Cost legacy management reads/writes that hide and reject historical R2 channels and defaults.

## External contract tests

Run manual/CI contract tests only against dedicated non-production WebDAV, Telegram, and S3-compatible test accounts. Validate timeout, authentication failure, rate limiting, remote deletion, and a streamed upload/download. Never place production tokens in test fixtures or logs. S3-compatible provider charges are external and must be approved by the operator before the test.

## Fault drills

1. Make WebDAV return a network error and confirm Telegram serves `/file/{fileId}`.
2. Make both adapters fail and confirm a `503` without a provider URL.
3. Deliver the same Queue job twice and confirm one D1 claim succeeds.
4. Create a tombstone, then send an old repair/create job and confirm it is cancelled.
5. Increase usage counters to `READ_ONLY` and confirm upload is rejected while an existing read remains allowed.
6. Add an active R2 binding in a disposable config copy and confirm `npm run check:zero-cost` fails.
7. Mark a job `running` with an expired lease, run scheduled maintenance, and confirm it returns to the bounded D1 redispatch set.
8. Set a channel to rate-limited and confirm its `blocked_until` timestamp excludes it from read candidates.
9. Make `head()` report a missing replica, run bounded maintenance at `NORMAL`, and confirm a durable repair job is created from a separate healthy source.
10. Set protection to `WRITE_LIMITED` and confirm the bounded critical-repair scan only queues a missing primary or sync-backup replica when exactly one readable source remains.
11. Seed legacy KV with a `cfr2` channel/default, query both management configuration endpoints in Zero-Cost mode, and confirm no R2 option or channel is returned; then confirm R2 POST payloads receive `400` without changing KV.
