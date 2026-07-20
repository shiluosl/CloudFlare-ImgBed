-- Additive V3 resilience metadata. Existing channels remain usable after migration.
ALTER TABLE storage_channels ADD COLUMN consecutive_successes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE storage_channels ADD COLUMN blocked_until INTEGER;

CREATE INDEX IF NOT EXISTS idx_channels_readable ON storage_channels(enabled, health_status, blocked_until, priority);
CREATE INDEX IF NOT EXISTS idx_jobs_lease_recovery ON storage_jobs(status, lease_until, run_after);
