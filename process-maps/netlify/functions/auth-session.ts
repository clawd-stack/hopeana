import { getStore } from '../../src/domain/context.ts';
import { currentUser, publicUser } from '../../src/lib/auth.ts';
import { SESSION_COOKIE, clearCookie, handler, json, requireMethod } from '../../src/lib/http.ts';

/**
 * GET  /api/auth/session  who am I (user is null when signed out)
 * POST /api/auth/session  sign out
 */
export default handler(async (request) => {
  requireMethod(request, 'GET', 'POST');
  if (request.method === 'POST') {
    return json({ ok: true, signedOut: true }, 200, { 'set-cookie': clearCookie(SESSION_COOKIE) });
  }
  const user = await currentUser(request, await getStore());
  return json({ ok: true, user: user ? publicUser(user) : null });
});

export const config = { path: '/api/auth/session' };
