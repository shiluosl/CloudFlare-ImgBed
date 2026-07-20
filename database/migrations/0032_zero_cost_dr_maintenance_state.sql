-- Bounded scheduler cursors keep maintenance scans fair without KV or Durable Objects.
CREATE TABLE IF NOT EXISTS maintenance_state (
  name TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
