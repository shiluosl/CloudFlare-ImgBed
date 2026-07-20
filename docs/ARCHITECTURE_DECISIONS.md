# Architecture Decisions

## ADR-001: R2 is disabled for the V3 deployment

`ZERO_COST_MODE=true` and `ALLOW_R2=false` are checked-in defaults. The Worker TOML has no R2 binding, the generator rejects `R2_BUCKET_NAME`, the adapter registry rejects `provider=r2`, and CI checks deployment configuration for prohibited paid resources. Historical upstream R2 code is retained only for legacy compatibility and is outside the V3 deployment path.

## ADR-002: D1 is the durable task record

Every replication, verification, repair, delete, and reconciliation task is stored in `storage_jobs`. Cloudflare Queue is only a wakeup transport, so duplicate, lost, or expired messages can be recovered by bounded cron redispatch from D1.

## ADR-003: Files are logical objects

V3 users receive `/file/{fileId}` only. Provider object locations and Telegram file identifiers remain internal replica metadata and are never returned as permanent public URLs.

## ADR-004: Tombstone-first deletion

Deletion atomically advances file generation, marks the file deleting, and inserts a tombstone before remote cleanup. Every job verifies generation and tombstone state, preventing delayed upload or repair jobs from restoring deleted data.

## ADR-005: At most two synchronous copies

The primary WebDAV replica and Telegram sync backup fit free-tier request and execution constraints. Additional copies are asynchronous jobs and are paused under usage pressure.

## ADR-006: Reads attempt at most two replicas

The read planner prefers healthy primary replicas, then a healthy backup. A successful fallback schedules repair rather than repairing inline, preserving predictable public-read latency and Worker resource use.

## ADR-007: V3 is additive

`files_v3` and related tables do not delete or mutate upstream storage tables. Existing `/upload`, legacy file paths, Docker storage behavior, and frontend remain available while operators migrate deliberately.
