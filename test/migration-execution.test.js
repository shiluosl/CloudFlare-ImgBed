import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

describe('zero-cost D1 migrations', () => {
  it('executes every V3 migration and creates recovery metadata', () => {
    const db = new Database(':memory:');
    const directory = resolve('database/migrations');
    const files = readdirSync(directory).filter(file => /^00(?:30|31)_.*\.sql$/.test(file)).sort();
    for (const file of files) db.exec(readFileSync(join(directory, file), 'utf8'));
    const columns = db.prepare("PRAGMA table_info('storage_channels')").all().map(column => column.name);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
    assert.ok(tables.includes('files_v3'));
    assert.ok(tables.includes('storage_jobs'));
    assert.ok(columns.includes('consecutive_successes'));
    assert.ok(columns.includes('blocked_until'));
    db.close();
  });
});
