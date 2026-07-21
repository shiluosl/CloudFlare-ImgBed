# Disaster Recovery Runbook

All operations preserve the logical URL `/file/{fileId}`. Never publish a provider URL or solve an outage by enabling R2, Workers Paid, or another paid Cloudflare product. Use `/ops.html` for bounded channel, file, job, audit, and protection-level inspection.

## Primary channel offline

Leave the logical URL online. The read service tries a healthy backup, writes a fallback audit event, and schedules repair without repairing inline. Mark the primary channel degraded or offline, correct authentication/network/quota causes, run a lightweight channel check, then retry bounded repair jobs after one healthy source is confirmed.

## Backup channel offline

Keep the primary readable. New safe uploads may become `degraded` when the synchronous backup cannot be written; strict uploads refuse the request. Restore the backup channel before attempting retry or repair, and do not make optional copies substitute for a required synchronous replica.

## Both channels offline

Public reads return `503` without exposing provider details. Pause uploads, identify one recoverable external provider, verify a representative replica with `head()`, then enable bounded repair from that source. Do not migrate data into paid Cloudflare storage.

## Many degraded files

Check channel health, credentials, queue state, and the current protection level before repair. Repair only from a known healthy source and avoid full-file or full-provider scans. In `WARNING`, `WRITE_LIMITED`, `READ_ONLY`, and `EMERGENCY`, prioritize deletion and the last readable copy. At `WRITE_LIMITED`, maintenance may repair only a required primary/synchronous-backup replica when exactly one readable source remains; normal verification and ordinary repair stay paused.

## Queue backlog

Queue is not authoritative. The fifteen-minute cron invokes bounded `redispatchDue(50)` from D1. In `READ_ONLY`, it recovers only deletion jobs; in `WRITE_LIMITED`, it additionally permits only the repair that protects a degraded/failed file with one readable replica; in `EMERGENCY`, it does not recover or dispatch jobs. Inspect pending/queued/retry-wait jobs, correct the provider cause, and let the bounded redispatch resume. Duplicate Queue messages are harmless because D1 job claiming and replica operations are idempotent.

## Dead jobs

Filter `storage_jobs` for `dead`, inspect the sanitized error and channel state, fix the underlying cause, then retry an individual job or a small selected batch. Cancel obsolete jobs for tombstoned files. Do not blindly retry a large dead-job population during a protection warning.

## D1 or Worker soft limits

At `WARNING`, pause nonessential verification, bulk migration, third-copy work, and high-frequency health checks. At `WRITE_LIMITED`, pause anonymous/bulk uploads and ordinary repair. `READ_ONLY` keeps existing reads, administrator access, deletion, and essential safety operations; it blocks uploads, registration, channel/policy mutation, and normal repair. `EMERGENCY` retains public reads and minimum status/safety access. Reduce workload or wait for the accounting window; never upgrade automatically or enable a paid Cloudflare service.

## Deletion failure

The tombstone immediately blocks reads and late create/repair work. Delete jobs retry; exhausting retries marks the file `delete_degraded`. Repair the provider cause and retry the delete job. Keep the tombstone until every replica is deleted or reported absent and `finalizeDeletion` marks the file `deleted`.

## Missing or corrupt replica

Use low-cost `head()`, size, ETag, or provider checksum evidence first. The maintenance cursor records `missing` or `corrupt`, recalculates logical health, and creates a repair job only when a readable source and writable target exist. Do not download every file to verify integrity. After repair, verify the target and review the file health/audit records.

## D1 export and restore

Export before risky maintenance:

```powershell
npx.cmd wrangler d1 export cloudflare-imgbed-zero-cost --remote --output d1-backup.sql
```

For recovery, create or select a replacement D1 database, apply migrations `0030` through `0034`, import a reviewed export through the approved Cloudflare process, update the generated `DB` binding, and deploy a previously validated Worker version. Keep the original database untouched until the restored instance passes a bounded job/file reconciliation. Migration `0034` also normalizes legacy policy thresholds to the two synchronous-copy zero-cost ceiling.

## Worker rollback

List versions and inspect the prior deployment configuration before rollback:

```powershell
npx.cmd wrangler versions list
npx.cmd wrangler rollback
```

Only roll back to a version without unsafe bindings. A Worker rollback does not restore D1 data or undo remote provider mutations, so follow it with a bounded reconciliation of recent/degraded files.

## Secret rotation

For a suspected WebDAV, Telegram, or S3-compatible credential leak, disable the affected channel, rotate the provider credential, update the Worker secret with `wrangler secret put`, and keep only the unchanged/new reference name in D1. Review audit records and recent jobs, perform a health check, then restore the channel and repair affected replicas. Never log the old or new value.

## Post-recovery reconciliation

Start with recently changed, failed, and degraded files rather than the full corpus. Confirm channel health, redispatch due jobs, verify a bounded set of replicas, and allow D1-backed repair to rebuild only documented missing/corrupt targets. Review the protection level after each batch and stop nonessential work immediately when it rises above `NORMAL`.
