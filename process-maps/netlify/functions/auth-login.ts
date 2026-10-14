import { getStore } from '../../src/domain/context.ts';
import { ensureBootstrapAdmin } from '../../src/domain/bootstrap.ts';
import { SESSION_TTL_DAYS, issueSession, publicUser, withinRateLimit } from '../../src/lib/auth.ts';
import { AppError } from '../../src/lib/errors.ts';
import { SESSION_COOKIE, clientIp, handler, isHttps, normaliseEmail, readJson, requireMethod, setCookie } from '../../src/lib/http.ts';
import { DUMMY_HASH, hashPassword, needsRehash, readPassword, verifyPassword } from '../../src/lib/password.ts';

/**
 * POST /api/auth/login  { email, password }
 *
 * Standalone only; inside Peggy, Peggy signs people in.
 *
 * Every failure returns the same message, status and timing: an unknown
 * address is checked against a dummy hash so it costs the same scrypt work as
 * a real one, because a fast "no" is an answer.
 */
export default handler(async (request) => {
  requireMethod(request, 'POST');
  const body = await readJson<{ email?: unknown; password?: unknown }>(request);
  const email = normaliseEmail(body.email);
  const password = readPassword(body.password);
  const store = await getStore();
  const ip = clientIp(request);

  if (!(await withinRateLimit(store, email, ip))) throw new AppError('RATE_LIMITED');
  await ensureBootstrapAdmin(store, email);

  const user = await store.users.getByEmail(email);
  const stored = user?.active && user.passwordHash ? user.passwordHash : DUMMY_HASH;
  const passwordOk = await verifyPassword(password, stored);
  if (!user || !user.active || !user.passwordHash || !passwordOk) {
    console.warn(`[process-maps] failed sign-in for ${email} from ${ip ?? 'unknown ip'}`);
    throw new AppError('SIGNIN_FAILED');
  }

  if (needsRehash(user.passwordHash)) await store.users.setPassword(user.userId, await hashPassword(password), user.mustChange);
  await store.users.recordLogin(user.userId);

  return new Response(JSON.stringify({ ok: true, user: publicUser(user) }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': setCookie(SESSION_COOKIE, issueSession(user.userId), SESSION_TTL_DAYS * 86_400, isHttps(request)),
    },
  });
});

export const config = { path: '/api/auth/login' };
