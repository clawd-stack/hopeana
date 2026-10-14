import { getStore } from '../../src/domain/context.ts';
import { SESSION_TTL_DAYS, issueSession, requireUser, withinRateLimit } from '../../src/lib/auth.ts';
import { AppError } from '../../src/lib/errors.ts';
import { SESSION_COOKIE, clientIp, handler, isHttps, json, readJson, requireMethod, setCookie } from '../../src/lib/http.ts';
import { hashPassword, readPassword, validatePassword, verifyPassword } from '../../src/lib/password.ts';

/**
 * POST /api/auth/password  { current, next }
 *
 * Change your own password. The current one is always required, including
 * when it is the temporary one an admin issued: a session left open on a
 * shared computer should not be enough to take the account. Every other
 * session on the account ends.
 */
export default handler(async (request) => {
  requireMethod(request, 'POST');
  const store = await getStore();
  const user = await requireUser(request, store, { allowMustChange: true });
  // An agent has a key, not a password; an admin replaces the key instead.
  if (user.isAgent) throw new AppError('FORBIDDEN');
  const body = await readJson<{ current?: unknown; next?: unknown }>(request);
  const current = readPassword(body.current);
  const next = readPassword(body.next);

  if (!(await withinRateLimit(store, user.email ?? user.userId, clientIp(request)))) throw new AppError('RATE_LIMITED');
  if (!user.passwordHash || !(await verifyPassword(current, user.passwordHash))) {
    throw new AppError('SIGNIN_FAILED', null, 'Your current password was not right.');
  }
  const problem = validatePassword(next);
  if (problem) throw new AppError('PASSWORD_REJECTED', null, problem.message);
  if (next === current) throw new AppError('PASSWORD_REJECTED', null, 'Please choose a password different from the current one.');

  await store.users.setPassword(user.userId, await hashPassword(next), false);
  // Changing the password ends every other session; this one carries on
  // with a fresh cookie.
  const updated = (await store.users.get(user.userId))!;
  return json({ ok: true }, 200, { 'set-cookie': setCookie(SESSION_COOKIE, issueSession(updated), SESSION_TTL_DAYS * 86_400, isHttps(request)) });
});

export const config = { path: '/api/auth/password' };
