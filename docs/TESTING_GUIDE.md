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

The unit suite uses mocked WebDAV and Telegram endpoints plus executable local SQLite coverage for the V3 migration files. The separate integration suite exercises `JobService` and the Queue consumer together using a local durable-job model: Queue-send failure followed by cron redispatch, expired leases, duplicate delivery, and tombstone/generation cancellation. Together they cover dual-write success and degraded outcomes, strict and fast modes, idempotency, MIME/extension policy enforcement, read failover, repair scheduling, tombstone generation, read-only protection, endpoint validation, redirect rejection, channel circuit-breaker states, fair rotation of the bounded maintenance health scan, malformed management JSON, Zero Cost Guard management rejections, R2 deployment scanning, and migration execution.

## External contract tests

Run manual/CI contract tests only against dedicated non-production WebDAV and Telegram test accounts. Validate timeout, authentication failure, rate limiting, remote deletion, and a streamed upload/download. Never place production tokens in test fixtures or logs.

## Fault drills

1. Make WebDAV return a network error and confirm Telegram serves `/file/{fileId}`.
2. Make both adapters fail and confirm a `503` without a provider URL.
3. Deliver the same Queue job twice and confirm one D1 claim succeeds.
4. Create a tombstone, then send an old repair/create job and confirm it is cancelled.
5. Increase usage counters to `READ_ONLY` and confirm upload is rejected while an existing read remains allowed.
6. Add an active R2 binding in a disposable config copy and confirm `npm run check:zero-cost` fails.
7. Mark a job `running` with an expired lease, run scheduled maintenance, and confirm it returns to the bounded D1 redispatch set.
8. Set a channel to rate-limited and confirm its `blocked_until` timestamp excludes it from read candidates.
