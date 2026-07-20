-- Zero-Cost DR V3 transition schema. Legacy `files` data remains untouched.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS storage_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('webdav', 'telegram', 's3', 'huggingface', 'discord')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  failure_domain TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  health_status TEXT NOT NULL DEFAULT 'unknown' CHECK (health_status IN ('unknown', 'healthy', 'degraded', 'offline', 'disabled', 'quota_blocked')),
  config_json TEXT NOT NULL DEFAULT '{}',
  secret_refs_json TEXT NOT NULL DEFAULT '{}',
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  last_success_at INTEGER,
  last_failure_at INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS storage_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  write_mode TEXT NOT NULL DEFAULT 'safe' CHECK (write_mode IN ('safe', 'strict', 'fast')),
  primary_channel_id TEXT NOT NULL REFERENCES storage_channels(id),
  sync_backup_channel_id TEXT REFERENCES storage_channels(id),
  async_channels_json TEXT NOT NULL DEFAULT '[]',
  required_copies INTEGER NOT NULL DEFAULT 2 CHECK (required_copies BETWEEN 1 AND 3),
  minimum_readable_copies INTEGER NOT NULL DEFAULT 1 CHECK (minimum_readable_copies BETWEEN 1 AND 3),
  auto_repair INTEGER NOT NULL DEFAULT 1 CHECK (auto_repair IN (0, 1)),
  stop_when_quota_risk INTEGER NOT NULL DEFAULT 1 CHECK (stop_when_quota_risk IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files_v3 (
  id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT UNIQUE,
  owner_id TEXT,
  policy_id TEXT NOT NULL REFERENCES storage_policies(id),
  status TEXT NOT NULL CHECK (status IN ('receiving', 'replicating', 'available', 'degraded', 'failed', 'deleting', 'delete_degraded', 'deleted')),
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  is_public INTEGER NOT NULL DEFAULT 1 CHECK (is_public IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS file_replicas (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files_v3(id),
  channel_id TEXT NOT NULL REFERENCES storage_channels(id),
  role TEXT NOT NULL CHECK (role IN ('primary', 'sync_backup', 'async_backup')),
  generation INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  remote_id TEXT,
  remote_metadata_json TEXT NOT NULL DEFAULT '{}',
  etag TEXT,
  checksum TEXT,
  size INTEGER,
  status TEXT NOT NULL CHECK (status IN ('planned', 'uploading', 'healthy', 'suspect', 'missing', 'corrupt', 'retry_wait', 'deleting', 'deleted', 'permanent_failure')),
  last_checked_at INTEGER,
  last_success_at INTEGER,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(file_id, channel_id, generation)
);

CREATE TABLE IF NOT EXISTS storage_jobs (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files_v3(id),
  replica_id TEXT REFERENCES file_replicas(id),
  channel_id TEXT REFERENCES storage_channels(id),
  operation TEXT NOT NULL CHECK (operation IN ('CREATE_REPLICA', 'VERIFY_REPLICA', 'REPAIR_REPLICA', 'DELETE_REPLICA', 'RECOUNT_FILE_HEALTH', 'RECONCILE_FILE')),
  generation INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'queued', 'running', 'retry_wait', 'succeeded', 'dead', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_after INTEGER NOT NULL,
  lease_until INTEGER,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL DEFAULT '{}',
  last_error_code TEXT,
  last_error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS file_tombstones (
  file_id TEXT PRIMARY KEY REFERENCES files_v3(id),
  generation INTEGER NOT NULL,
  reason TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  finalized_at INTEGER
);

CREATE TABLE IF NOT EXISTS usage_counters (
  day TEXT PRIMARY KEY,
  worker_requests INTEGER NOT NULL DEFAULT 0,
  d1_reads INTEGER NOT NULL DEFAULT 0,
  d1_writes INTEGER NOT NULL DEFAULT 0,
  queue_operations INTEGER NOT NULL DEFAULT 0,
  uploads INTEGER NOT NULL DEFAULT 0,
  database_bytes_estimate INTEGER NOT NULL DEFAULT 0,
  protection_level TEXT NOT NULL DEFAULT 'NORMAL' CHECK (protection_level IN ('NORMAL', 'WARNING', 'WRITE_LIMITED', 'READ_ONLY', 'EMERGENCY')),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  request_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_channels_health ON storage_channels(enabled, health_status, priority);
CREATE INDEX IF NOT EXISTS idx_files_v3_status_created ON files_v3(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_v3_policy ON files_v3(policy_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_replicas_file_status ON file_replicas(file_id, status, role);
CREATE INDEX IF NOT EXISTS idx_replicas_channel_status ON file_replicas(channel_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_dispatch ON storage_jobs(status, run_after, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_file ON storage_jobs(file_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
