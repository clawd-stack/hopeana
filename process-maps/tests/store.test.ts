import { createMemoryStore } from '../src/store/memory.ts';
import { closePgStore, createPgStore } from '../src/store/pg.ts';
import { describe } from 'vitest';
import { storeContract } from './store-contract.ts';

storeContract('memory', createMemoryStore);

/**
 * The same contract against a real Postgres, with the migration applied.
 * Skipped unless DATABASE_URL is set, so `npm test` needs no database:
 *   createdb process_maps_test
 *   psql -d process_maps_test -f netlify/database/migrations/001_process-maps/migration.sql
 *   DATABASE_URL=postgres://localhost/process_maps_test npm test
 */
if (process.env.DATABASE_URL) {
  storeContract('postgres', () => createPgStore(process.env.DATABASE_URL), closePgStore);
} else {
  describe.skip('postgres store (set DATABASE_URL to run)', () => {});
}
