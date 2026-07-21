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

## ADR-008: Queue worker leases are recoverable

`running` jobs include a bounded lease. Scheduled maintenance moves expired leases to `retry_wait` before D1 redispatch, so a Worker interruption after claiming a Queue message cannot leave a durable job permanently stranded. Guard-paused work is deferred without consuming an external-storage retry attempt.

## ADR-009: Health is based on real storage operations

Adapter reads, writes, verification, deletion, and health probes report sanitized outcomes to `ChannelHealthService`. Three consecutive network failures degrade a channel, five mark it offline, authorization failure marks it offline immediately, rate limits set `blocked_until`, and two successes restore healthy status. Read planning excludes offline, quota-blocked, disabled, and rate-paused channels.

## ADR-010: Secrets are references only in V3 adapters

WebDAV and Telegram adapters only read credentials from configured Worker secret-reference names. Plaintext credentials in historical channel config are ignored, Authorization headers in config are rejected, and external redirects are refused instead of followed. This limits SSRF and credential-leak exposure in the V3 path.

## ADR-011: Deployment bindings are generated only for a real deployment

The repository does not commit a D1 database identifier or Queue name. `npm run deploy:worker` requires `D1_DATABASE_ID` and `STORAGE_QUEUE_NAME`, generates the Worker TOML for that command, then validates `DB` and `STORAGE_QUEUE` bindings before Wrangler runs. The checked-in TOML remains suitable for source inspection and configuration-only dry-runs, but cannot accidentally present itself as a functional V3 deployment.

## ADR-012: Historical R2 paths are isolated and V3 has independent rollback flags

Upstream legacy code still contains historical R2 behavior for compatibility. In Zero-Cost mode the generated Worker exposes a proxy environment that hides `img_r2` and `R2`, and it rejects the historical `uploadChannel=cfr2` request before routing. V3 upload and V3 logical read have independent `ENABLE_V3_UPLOAD` and `ENABLE_V3_READ` flags, so an operator can pause new logical uploads or roll reads back to the legacy route surface without enabling R2 or changing paid-resource configuration.

## ADR-013: Availability requires the required synchronous replicas

`available` means the primary and synchronous backup are healthy. Healthy asynchronous replicas remain useful for repair and read recovery, but they cannot hide a failed required backup. Upload preflight also rejects a policy whose required channel is already disabled, offline, or quota-blocked before creating the logical file record. V3 uploads enforce a bounded MIME-to-extension policy; environment variables can narrow the default set, while new MIME families require an explicit code review and mapping.

## ADR-014: The V3 Worker deployment and local start path use no KV namespace binding

The strict zero-cost V3 resource allowlist is limited to Workers, D1, Queues, static assets, Cache API, and optional Turnstile. The deployment generator rejects `KV_NAMESPACE_ID`, generated deployment TOML cannot contain `[[kv_namespaces]]`, and CI validates that boundary. `npm start` builds the generated Worker then starts it with an ignored local D1/Queue simulation TOML; it has no KV or R2 binding. Historical upstream Pages/Docker compatibility code may still mention KV, but it is not a V3 Worker deployment or local-development dependency.

## ADR-015: Maintenance uses a D1 rotation cursor

Health probes must be bounded to preserve free-tier capacity, but a fixed first-page query can starve later channels indefinitely. `maintenance_state` stores only a named numeric cursor in D1. Each eligible scheduled run probes at most five channels after that cursor and wraps to the first page only after reaching the end. This gives every channel eventual lightweight assessment without KV, Durable Objects, whole-table scans, or high-frequency probing.

## ADR-016: Replica reconciliation is bounded and repair-driven

At `NORMAL`, scheduled maintenance reads at most five eligible replicas through a separate `replica_maintenance_cursor`. Healthy and suspect replicas receive low-cost `head()` verification no more often than the configured verification interval. Planned, missing, corrupt, and retry-wait replicas receive durable create or repair work using time-bucketed idempotency keys. A definitive `NOT_FOUND` becomes `missing`; a size mismatch becomes `corrupt`; both recompute logical-file health and schedule a repair only when another readable source exists and the policy permits auto-repair. The target channel is checked for enabled, health, quota, and rate-limit state before source data is opened. This closes silent-loss recovery without full scans, Queue payload growth, or synchronous user-read repair.

At `WRITE_LIMITED`, normal verification and ordinary repair remain paused. A second bounded cursor may schedule only a missing, corrupt, planned, uploading, or retry-wait primary/synchronous-backup replica when the logical file is `degraded` and exactly one readable healthy source remains. Those jobs are explicitly essential for Queue dispatch; they protect the last remaining copy without reopening bulk maintenance.

## ADR-017: Worker request usage is sampled, never synchronously metered per read

The `worker_requests` counter is an application estimate used by the Zero Cost Guard, not a billing substitute. The deployed Worker samples V3 public-read, operations API, Queue, and scheduled invocations at `WORKER_REQUEST_SAMPLE_RATE` (default `100`) and records the corresponding estimated increment asynchronously with `waitUntil`. The same sampled upsert adds `D1_READS_PER_SAMPLED_V3_REQUEST` (default `3`) per sampled request, so D1 read pressure is visible without a metering write per public read. Successful uploads add a bounded `database_bytes_estimate` for the logical-file and replica metadata; it is a conservative trend indicator, not D1 billing telemetry. A rate-paused synchronous channel is also rejected before logical-file creation, so a known Telegram/WebDAV `Retry-After` interval cannot create an immediately stranded file.

## ADR-018: Policy copy thresholds guide health, not failover denial

V3 stores `required_copies` and `minimum_readable_copies` as bounded values from one to two, matching the zero-cost maximum of two synchronous channels. The larger value determines whether synchronous health is `available` or `degraded`; asynchronous copies cannot satisfy it. A file with one healthy synchronous replica remains readable even when the target is two, because hiding the last healthy copy would contradict transparent failover. `stop_when_quota_risk` is enforced before logical-file creation: policies with that safeguard pause uploads at any non-`NORMAL` protection level, while the global Zero Cost Guard remains authoritative for stronger system-wide limits.

## ADR-019: Optional S3-compatible storage remains outside the Cloudflare cost boundary

The V3 S3-compatible adapter uses only public HTTPS S3 APIs and Worker secret-reference names for access credentials. It has no R2 binding, does not accept URL credentials, rejects unsafe/private endpoints by default, and never returns provider URLs. This permits an operator to use a separately managed S3-compatible provider as an optional replica while keeping Cloudflare deployment resources strictly limited to Workers Free, D1 Free, Queues Free, static assets, Cache API, and optional Turnstile. External provider charges remain the operator's responsibility and are displayed as a risk in operations configuration; Cloudflare R2 remains prohibited in the registry, API, deployment generator, and CI scanner.

## ADR-020: Channel configuration can only narrow an adapter contract

Each provider has a code-owned capability ceiling. A channel may disable an operation or lower its maximum object size through `capabilities_json`, but it cannot claim an unsupported feature or raise a provider limit. Policy creation and upload preflight require read, write, and delete capability for every selected replica channel before any logical-file row is created. This keeps the adapter contract authoritative, avoids late task failures caused by optimistic metadata, and exposes the effective capability set through the operations API.

## ADR-021: Cron redispatch honors the Zero Cost Guard before lease recovery

Recovering an expired Queue-worker lease is a D1 write and can immediately lead to a Queue operation, so it is not an unconditional housekeeping action. Scheduled maintenance obtains the current protection level before calling the durable-job service. At `READ_ONLY`, only `DELETE_REPLICA` work may be recovered and redispatched because tombstoned deletion is an explicitly allowed safety operation. At `WRITE_LIMITED`, deletion plus a degraded/failed required primary or synchronous-backup repair with exactly one readable replica may proceed. At `EMERGENCY`, no leases are recovered and no jobs are dispatched. The repository first selects expired jobs, then updates only approved IDs; ordinary paused leases remain `running` until the protection level permits recovery or an operator intervenes.

## ADR-022: Storage endpoints never allow private-network exceptions

WebDAV, S3-compatible, and optional Telegram proxy URLs must resolve from a public `https` endpoint without embedded credentials. V3 rejects localhost, loopback, RFC1918, link-local, CGNAT, IPv4-mapped IPv6, and local IPv6 destinations. The former `allowPrivateEndpoint` setting is rejected by the management API and ignored by adapters, so an old D1 record cannot turn a Worker into an internal-network request proxy. Redirects remain disabled or rejected by adapters, preventing a public endpoint from redirecting to a private target.

## ADR-023: A matched V3 logical file never falls through to legacy storage

The `/file/{fileId}` route first checks the additive V3 logical-file record. Once a record exists, its V3 `FileService` response is authoritative: unexpected lookup or adapter failures produce a sanitized `503` rather than attempting the historical single-channel route with the same identifier. Legacy fallback is allowed only when no V3 record exists, the V3 D1 binding is unavailable, or the V3 migrations are absent during a controlled rollback. This prevents an identifier collision or runtime exception from bypassing V3 tombstone, replica-health, and access boundaries.

## ADR-024: Zero-Cost mode also isolates historical R2 request surfaces

Historical upstream R2 implementation remains in the repository for non-V3 compatibility, but `ZERO_COST_MODE=true` omits `cfr2` from the legacy channel-list API and rejects R2 at the legacy upload route, R2 upload function, chunked-upload initialization, and chunked-upload continuation/merge after reading a persisted session. Automatic legacy retry also removes R2 from its candidate list. This closes the gap where a session created before a configuration change could otherwise reach R2 without repeating `uploadChannel=cfr2` in the URL.

## ADR-025: Deletion initialization is an atomic D1 batch and Queue is only a wake-up

The initial deletion batch advances the logical-file generation, records the tombstone, marks every remaining replica `deleting`, inserts idempotent `DELETE_REPLICA` durable jobs, and records the delete-request audit event together. A Queue send occurs only after that batch and is intentionally best-effort: cron redispatch can awaken the D1-backed work if it fails. Tombstone insertion is conflict-safe, so concurrent delete requests converge on the first tombstone rather than replacing history or failing after partial cleanup. This guarantees that a Worker interruption or Queue outage cannot leave a newly tombstoned file without durable deletion work.

## ADR-026: V3 logical-file reads bypass shared Cache API

`/file/{fileId}` responses are always `private, no-store`, and the generated Worker bypasses both Cache API lookup and storage for that route. Cache API entries are scoped to an edge location and cannot provide a globally synchronous invalidation guarantee when a D1 tombstone is committed. Routing every V3 logical-file read through `FileService` ensures the tombstone check takes effect immediately, which is more important than public-read cache savings for deletion correctness. Cache API remains an allowed temporary optimization for non-V3 routes and is never a persistent replica.

## ADR-027: Private V3 files use explicit default-deny authorization

`files_v3.is_public=0` is enforced before a request reaches `FileService`. A configured user auth code, configured administrator session, or validated API token is required; when neither user nor administrator authentication is configured, only a validated API token can grant access. This intentionally differs from the historical user-auth compatibility helper, which treats an absent user auth-code configuration as public access. Failed private-file authorization returns `404` rather than `401` or `403`, so logical file IDs are not exposed as an enumeration oracle. Public V3 reads perform no security-configuration lookup and remain available at `/file/{fileId}`.

## ADR-028: Anonymous V3 upload is explicit opt-in and Turnstile-gated

`ENABLE_ANONYMOUS_V3_UPLOAD` defaults to `false` in deployment, local-start, and example configurations. When an operator explicitly enables it, `POST /api/upload/v3` performs server-side Turnstile Siteverify with a five-second bound before constructing the runtime or calling `UploadService`. A missing secret or token, failed HTTP request, rejected challenge, timeout, or malformed response fails closed. The route accepts only public `safe` uploads, assigns no owner, and disregards caller-controlled owner, visibility, administrator, mode, and file-ID fields. Turnstile tokens and secrets are not logged or returned. The route does not bypass the normal upload service: Zero Cost Guard, MIME and size validation, policy capability checks, replica state, durable work, and audit persistence remain authoritative there.

## ADR-029: D1 enforces the synchronous-copy policy ceiling

The operations API and runtime already limit `required_copies` and `minimum_readable_copies` to one or two, but application validation alone is not sufficient when an operator or recovery procedure writes D1 directly. Migration `0034_zero_cost_dr_policy_copy_bounds.sql` normalizes pre-existing V3 values and installs insert/update triggers that reject values outside one to two or a readable threshold above the required threshold. Async replicas remain unconstrained by this policy field; they are explicitly asynchronous and cannot satisfy the synchronous availability target.

## ADR-030: Queue guard checks precede durable job claims

Queue delivery can arrive long after a job was dispatched, including after the Zero Cost Guard enters `WRITE_LIMITED`, `READ_ONLY`, or `EMERGENCY`. The consumer first performs a read-only durable-job lookup and applies the operation-specific guard before `claimJob()` changes status to `running` or increments attempts. A paused message is acknowledged with its durable job unchanged, leaving bounded cron redispatch to wake it after the protection level permits execution. The consumer repeats the guard after a successful claim to defend against a level change during the claim race. Tombstoned deletion remains executable in `READ_ONLY`, while `EMERGENCY` pauses even deletion.

## ADR-031: Zero-Cost mode filters legacy R2 management configuration

The upstream management frontend and KV schema retain historical R2 fields for compatibility outside the Zero-Cost deployment profile. When `ZERO_COST_MODE=true`, legacy upload-settings reads return only an empty `cfr2` shape needed by existing frontend helpers; they never expose an R2 environment binding or persisted R2 channel. The legacy page-settings read removes the R2 default-channel option and clears an old R2 selection. Both write endpoints reject a non-empty R2 channel configuration or an R2 default-channel selection with `400` instead of silently persisting it. This keeps historical records available for a deliberately non-zero-cost compatibility deployment while ensuring the zero-cost administrative surface cannot create, select, or reactivate R2; route and runtime guards remain defense in depth.

## ADR-032: CI validates the binding contract without committing resource identifiers

`deploy/worker/wrangler.toml` intentionally remains identifier-free, so its Wrangler dry run checks generated Worker syntax and the zero-cost variable boundary only. `wrangler.toml.example` is a non-deployable binding-contract template with placeholder D1 and Queue values. CI runs `validate-worker-deployment.mjs --config wrangler.toml.example` to require `DB`, the `STORAGE_QUEUE` producer, and a Queue consumer while rejecting R2, KV, and other paid bindings. A real deployment still regenerates the active TOML from operator-provided identifiers and runs the same validator before Wrangler executes.

## ADR-033: Uncertain remote writes favor durable retry over provider scans

An adapter result becomes a healthy replica only after D1 records its remote metadata. If the remote write succeeds but that acknowledgement is interrupted, the durable job retries and does not falsely mark the replica healthy. Deterministic WebDAV and S3-compatible object keys make retries naturally convergent. Telegram cannot accept a deterministic object key or a caller-provided idempotency token through `sendDocument`, and reconstructing an unknown successful send would require a prohibited chat-history scan. The system therefore preserves logical-file safety and bounded retry semantics, documents the possible orphaned Telegram message, and leaves narrow manual cleanup to the operator rather than spending free-tier capacity on global discovery.
