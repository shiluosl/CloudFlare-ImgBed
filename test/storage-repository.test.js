import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { StorageRepository } from '../functions/repositories/storageRepository.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

describe('storage repository replica roles', () => {
  it('only promotes a healthy synchronous backup and swaps the two synchronous roles', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(readFileSync(join(resolve('database/migrations'), '0030_zero_cost_dr_v3.sql'), 'utf8'));
    seedReplicaRoles(sqlite);
    const repository = new StorageRepository(d1FromSqlite(sqlite));

    assert.equal(await repository.switchPrimaryReplica('file_1', 'async'), null);
    assert.equal(sqlite.prepare('SELECT role FROM file_replicas WHERE id=?').get('async').role, 'async_backup');

    const promoted = await repository.switchPrimaryReplica('file_1', 'backup');
    assert.equal(promoted.role, 'primary');
    assert.deepEqual(sqlite.prepare('SELECT id, role FROM file_replicas WHERE file_id=? ORDER BY id').all('file_1'), [
      { id: 'async', role: 'async_backup' },
      { id: 'backup', role: 'primary' },
      { id: 'primary', role: 'sync_backup' },
    ]);
    sqlite.close();
  });
});

function seedReplicaRoles(db) {
  db.exec(`INSERT INTO storage_channels(id,name,provider,failure_domain,created_at,updated_at) VALUES
    ('webdav','WebDAV','webdav','webdav-zone',1,1),
    ('telegram','Telegram','telegram','telegram-zone',1,1),
    ('s3','S3','s3','s3-zone',1,1);
    INSERT INTO storage_policies(id,name,primary_channel_id,sync_backup_channel_id,created_at,updated_at)
      VALUES ('policy_1','policy_1','webdav','telegram',1,1);
    INSERT INTO files_v3(id,policy_id,status,name,content_type,size,created_at,updated_at)
      VALUES ('file_1','policy_1','available','demo.txt','text/plain',4,1,1);
    INSERT INTO file_replicas(id,file_id,channel_id,role,generation,object_key,status,created_at,updated_at) VALUES
      ('primary','file_1','webdav','primary',1,'file_1/demo.txt','healthy',1,1),
      ('backup','file_1','telegram','sync_backup',1,'file_1/demo.txt','healthy',1,1),
      ('async','file_1','s3','async_backup',1,'file_1/demo.txt','healthy',1,1);`);
}

function d1FromSqlite(sqlite) {
  return {
    prepare(sql) {
      return {
        bind(...values) {
          const statement = sqlite.prepare(sql);
          return {
            async first() { return statement.get(...values) || null; },
            async all() { return { results: statement.all(...values) }; },
            async run() { const result = statement.run(...values); return { meta: { changes: result.changes } }; },
          };
        },
      };
    },
    async batch(statements) { return Promise.all(statements.map(statement => statement.run())); },
  };
}
