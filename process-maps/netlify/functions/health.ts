import { getStore } from '../../src/domain/context.ts';
import { env } from '../../src/lib/env.ts';
import { json } from '../../src/lib/http.ts';

/**
 * GET /api/health
 *
 * Says plainly whether this deploy is ready for the team: a database, a
 * session secret, and a way for the first admin to get in.
 */
export default async (): Promise<Response> => {
  const checks: Record<string, { ok: boolean; note: string }> = {};

  checks.sessionSecret = env.hasSessionSecret
    ? { ok: true, note: 'SESSION_SECRET is set.' }
    : { ok: false, note: 'Set SESSION_SECRET (32+ random bytes). Nobody can sign in without it.' };

  try {
    const store = await getStore();
    const users = await store.users.list();
    const admins = users.filter((u) => u.active && u.role === 'admin').length;
    checks.database = { ok: true, note: env.hasDatabaseUrl ? 'Connected to Postgres.' : 'Connected.' };
    checks.admin =
      admins > 0 || process.env.ADMIN_BOOTSTRAP_EMAIL
        ? { ok: true, note: `${admins} active admin${admins === 1 ? '' : 's'}.` }
        : { ok: false, note: 'No admin yet. Set ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD, then sign in.' };
  } catch (error) {
    console.error('[process-maps] health: database check failed', error);
    const missing = error instanceof Error && error.message.startsWith('No database configured');
    checks.database = { ok: false, note: missing ? 'No database. Enable Netlify DB for this site, or set DATABASE_URL.' : 'The database is not reachable.' };
  }

  const ok = Object.values(checks).every((c) => c.ok);
  return json({ ok, checks }, ok ? 200 : 503);
};

export const config = { path: '/api/health' };
