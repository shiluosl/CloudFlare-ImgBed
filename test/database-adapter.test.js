import assert from 'node:assert/strict';
import { checkDatabaseConfig, getDatabase } from '../functions/utils/databaseAdapter.js';
import { D1Database } from '../functions/utils/d1Database.js';

describe('database adapter deployment binding compatibility', () => {
  it('uses the V3 DB binding for legacy database consumers', () => {
    const binding = { prepare() {} };
    const database = getDatabase({ DB: binding });
    const config = checkDatabaseConfig({ DB: binding });

    assert.ok(database instanceof D1Database);
    assert.equal(database.db, binding);
    assert.equal(config.hasD1, true);
    assert.equal(config.usingD1, true);
    assert.equal(config.configured, true);
  });
});
