# Disaster Recovery Runbook

## Channel outage

For a primary outage, leave the logical file URL online. The read service attempts the healthy backup and records a repair job. Use `/ops.html` to run a channel health check, inspect jobs, and retry only after the provider recovers. For backup-only outage, keep writes in `safe` mode only if the primary remains healthy; affected files become `degraded` and repair is deferred.

When both channels are unavailable, public reads return `503` without exposing provider URLs. Do not switch to paid Cloudflare storage. Restore one external channel, verify one replica, then use bounded repair jobs.

## Queue backlog or dead jobs

Queue is not the source of truth. The fifteen-minute cron calls `redispatchDue(50)`. Inspect `storage_jobs` by status, retry a dead job only after correcting its channel cause, and cancel obsolete pending work. A repeated Queue message is harmless because D1 job claiming is idempotent.

## Many degraded files

Check storage channel authentication, health status, and free-tier protection level. Repair from a healthy replica only; do not bulk download all files. During `WARNING`, `WRITE_LIMITED`, `READ_ONLY`, or `EMERGENCY`, prioritize critical files and deletes.

## Deletion failure

The tombstone blocks public reads and late repair/create tasks immediately. Delete jobs retry; exhausted deletions mark the file `delete_degraded`. Resolve the remote provider failure and retry the delete job. Do not remove the tombstone until all replicas are deleted and `finalizeDeletion` marks the file `deleted`.

## D1 backup and recovery

Before risky maintenance, export D1:

```powershell
npx.cmd wrangler d1 export cloudflare-imgbed-zero-cost --remote --output d1-backup.sql
```

To recover, create or select a replacement D1 database, apply migrations, import the reviewed backup using the approved Cloudflare process, update the `DB` binding, and deploy a tested Worker version. Reconcile files by checking only recently changed or degraded replicas, then let D1 jobs rebuild missing copies.

## Usage protection

`READ_ONLY` permits existing reads, administrator access, deletion, and essential safety work; uploads and normal repair stop. `EMERGENCY` should retain only existing public reads and minimal status access. Never resolve a quota condition by enabling a paid product or automatic plan upgrade.

## Secret exposure and rollback

Rotate the affected provider secret immediately, update the Worker secret, disable the compromised channel, audit affected files, then health check and repair. Use `npx.cmd wrangler versions list` and `npx.cmd wrangler rollback` only after confirming the prior version has no unsafe bindings; rollback does not replace D1 backup/restore procedures.
