# Testing Guide

## Local checks

```powershell
npm.cmd test
npm.cmd run test:unit
npm.cmd run test:integration
npm.cmd run lint
npm.cmd run check:migrations
npm.cmd run check:secrets
npm.cmd run build
npx.cmd wrangler deploy --dry-run --config deploy/worker/wrangler.toml
```

The test suite uses mocked WebDAV and Telegram endpoints. It covers dual-write success and degraded outcomes, strict and fast modes, idempotency, read failover, repair scheduling, tombstone generation, late-job prevention, duplicate recount behavior, read-only protection, endpoint validation, and R2 deployment scanning.

## External contract tests

Run manual/CI contract tests only against dedicated non-production WebDAV and Telegram test accounts. Validate timeout, authentication failure, rate limiting, remote deletion, and a streamed upload/download. Never place production tokens in test fixtures or logs.

## Fault drills

1. Make WebDAV return a network error and confirm Telegram serves `/file/{fileId}`.
2. Make both adapters fail and confirm a `503` without a provider URL.
3. Deliver the same Queue job twice and confirm one D1 claim succeeds.
4. Create a tombstone, then send an old repair/create job and confirm it is cancelled.
5. Increase usage counters to `READ_ONLY` and confirm upload is rejected while an existing read remains allowed.
6. Add an active R2 binding in a disposable config copy and confirm `npm run check:zero-cost` fails.
