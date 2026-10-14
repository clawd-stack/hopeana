import { createMemoryStore } from '../store/memory.ts';
import { createPgStore } from '../store/pg.ts';
import { env } from '../lib/env.ts';
import type { Store } from '../store/types.ts';

/**
 * Which store a request gets is decided by environment, never by a caller,
 * so no endpoint can quietly fall back to memory in production.
 */

let cached: Store | null = null;

export async function getStore(): Promise<Store> {
  if (cached) return cached;

  // An explicit connection string wins, so local work and CI can point at
  // their own Postgres. Otherwise ask Netlify DB, which provisions the
  // database on deploy and knows which branch this deploy should talk to.
  if (env.hasDatabaseUrl) {
    cached = createPgStore();
    return cached;
  }

  try {
    const { getConnectionString } = await import('@netlify/database');
    const connectionString = getConnectionString();
    if (connectionString) {
      cached = createPgStore(connectionString);
      return cached;
    }
  } catch {
    // Not running on Netlify, or the package is unavailable. Fall through.
  }

  // Memory only when asked for by name. Anything else with no database is a
  // deploy missing Netlify DB, where a store that silently forgets every map
  // on the next cold start would be far worse than an error.
  if (process.env.PROCESS_MAPS_MEMORY_STORE !== '1' || env.isProduction) {
    throw new Error('No database configured: enable Netlify DB for this site, or set DATABASE_URL');
  }
  console.warn('[process-maps] No database: using the in-memory store. Nothing will persist.');
  cached = createMemoryStore();
  return cached;
}

/** Test seam: lets the suite inject a store. */
export function overrideStore(store: Store | null): void {
  cached = store;
}
