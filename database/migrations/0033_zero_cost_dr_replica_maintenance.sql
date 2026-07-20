-- Bounded replica reconciliation reads candidates by rowid and low-cost verification state.
CREATE INDEX IF NOT EXISTS idx_replicas_maintenance
  ON file_replicas(status, last_checked_at, file_id, generation);
