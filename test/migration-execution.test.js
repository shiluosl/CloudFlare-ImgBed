import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

describe('zero-cost D1 migrations', () => {
  it('normalizes pre-existing three-copy policy thresholds during upgrade', () => {
    const db = new Database(':memory:');
    const directory = resolve('database/migrations');
    db.exec(readFileSync(join(directory, '0030_zero_cost_dr_v3.sql'), 'utf8'));
    db.prepare(`INSERT INTO storage_channels
      (id,name,provider,failure_domain,created_at,updated_at)
      VALUES ('webdav','WebDAV','webdav','primary',1,1), ('telegram','Telegram','telegram','backup',1,1)`).run();
    db.prepare(`INSERT INTO storage_policies
      (id,name,primary_channel_id,sync_backup_channel_id,required_copies,minimum_readable_copies,created_at,updated_at)
      VALUES ('legacy-three','legacy-three','webdav','telegram',3,3,1,1)`).run();
    db.exec(readFileSync(join(directory, '0034_zero_cost_dr_policy_copy_bounds.sql'), 'utf8'));
    const policy = db.prepare('SELECT required_copies, minimum_readable_copies FROM storage_policies WHERE id=?').get('legacy-three');
    assert.deepEqual(policy, { required_copies: 2, minimum_readable_copies: 2 });
    db.close();
  });

  it('executes every V3 migration and creates recovery metadata', () => {
    const db = new Database(':memory:');
    const directory = resolve('database/migrations');
    const files = readdirSync(directory).filter(file => /^003[0-4]_.*\.sql$/.test(file)).sort();
    for (const file of files) db.exec(readFileSync(join(directory, file), 'utf8'));
    const columns = db.prepare("PRAGMA table_info('storage_channels')").all().map(column => column.name);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
    assert.ok(tables.includes('files_v3'));
    assert.ok(tables.includes('storage_jobs'));
    assert.ok(tables.includes('maintenance_state'));
    assert.ok(columns.includes('consecutive_successes'));
    assert.ok(columns.includes('blocked_until'));
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").all().map(row => row.name);
    assert.ok(indexes.includes('idx_replicas_maintenance'));
    db.prepare(`INSERT INTO storage_channels
      (id,name,provider,failure_domain,created_at,updated_at)
      VALUES ('webdav','WebDAV','webdav','primary',1,1), ('telegram','Telegram','telegram','backup',1,1)`).run();
    assert.throws(() => db.prepare(`INSERT INTO storage_policies
      (id,name,primary_channel_id,sync_backup_channel_id,required_copies,minimum_readable_copies,created_at,updated_at)
      VALUES ('invalid','invalid','webdav','telegram',3,1,1,1)`).run(), /two synchronous-copy limit/);
    assert.throws(() => db.prepare(`INSERT INTO storage_policies
      (id,name,primary_channel_id,sync_backup_channel_id,required_copies,minimum_readable_copies,created_at,updated_at)
      VALUES ('invalid-readable','invalid-readable','webdav','telegram',1,2,1,1)`).run(), /two synchronous-copy limit/);
    db.prepare(`INSERT INTO storage_policies
      (id,name,primary_channel_id,sync_backup_channel_id,required_copies,minimum_readable_copies,created_at,updated_at)
      VALUES ('valid','valid','webdav','telegram',2,1,1,1)`).run();
    assert.throws(() => db.prepare('UPDATE storage_policies SET minimum_readable_copies=3 WHERE id=?').run('valid'), /two synchronous-copy limit/);
    db.close();
  });

  it('keeps legacy initialization compatible with the historical tags migration', () => {
    const db = new Database(':memory:');
    const root = resolve('database');
    db.exec(readFileSync(join(root, 'init.sql'), 'utf8'));
    db.exec(readFileSync(join(root, 'migrations', 'v2.2.1_add_tags_column.sql'), 'utf8'));
    const columns = db.prepare("PRAGMA table_info('files')").all().map(column => column.name);

    assert.ok(columns.includes('tags'));
    db.close();
  });
});
