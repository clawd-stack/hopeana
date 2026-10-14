import { AppError } from './errors.ts';
import { env } from './env.ts';
import { SESSION_COOKIE, readCookie } from './http.ts';
import { hashToken, signSession, verifySession } from './crypto.ts';
import type { Store, UserRecord } from '../store/types.ts';

/**
 * Who is calling.
 *
 * THIS FILE IS THE PEGGY SEAM. Standalone, the module signs its own team in
 * with email and password and a signed HttpOnly cookie. Inside Peggy, Peggy
 * already knows who is signed in, so requireUser() is the one function that
 * changes: make it read Peggy's session and return a UserRecord-shaped value
 * (userId, name, role). Nothing else in the module reads cookies.
 *
 * The cookie only says which account; the account itself is re-read on every
 * request, so deactivating somebody or changing their role takes effect on
 * their next request rather than when their cookie expires.
 */

export const SESSION_TTL_DAYS = 14;
export const LOGIN_RATE_LIMIT = 8;
export const LOGIN_RATE_WINDOW_MS = 15 * 60_000;

interface SessionPayload {
  kind: 'pm-user';
  userId: string;
  /** The account's sessionVersion when this was issued. */
  v: number;
  exp: number;
}

export function issueSession(user: { userId: string; sessionVersion: number }): string {
  const payload: SessionPayload = {
    kind: 'pm-user',
    userId: user.userId,
    v: user.sessionVersion,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_DAYS * 86_400,
  };
  return signSession(env.sessionSecret, payload as unknown as Record<string, unknown>);
}

function readSession(request: Request): { userId: string; v: number } | null {
  const cookie = readCookie(request, SESSION_COOKIE);
  if (!cookie) return null;
  const payload = verifySession<SessionPayload>(env.sessionSecret, cookie);
  if (payload?.kind !== 'pm-user' || typeof payload.userId !== 'string' || typeof payload.v !== 'number') return null;
  return { userId: payload.userId, v: payload.v };
}

/** The signed-in user, or null. A cookie from before a password change no longer counts. */
export async function currentUser(request: Request, store: Store): Promise<UserRecord | null> {
  const session = readSession(request);
  if (!session) return null;
  const user = await store.users.get(session.userId);
  return user && user.active && user.sessionVersion === session.v ? user : null;
}

/**
 * The signed-in user, who must also have replaced any password an admin
 * issued: that is enforced here, not only by the sign-in screen, so a
 * temporary password is good for choosing a new one and nothing else.
 */
export async function requireUser(request: Request, store: Store, { allowMustChange = false } = {}): Promise<UserRecord> {
  const user = await currentUser(request, store);
  if (!user) throw new AppError('UNAUTHENTICATED');
  if (user.mustChange && !allowMustChange) throw new AppError('PASSWORD_CHANGE_REQUIRED');
  return user;
}

export function canEdit(user: UserRecord): boolean {
  return user.role === 'admin' || user.role === 'editor';
}

export async function requireEditor(request: Request, store: Store): Promise<UserRecord> {
  const user = await requireUser(request, store);
  if (!canEdit(user)) throw new AppError('READ_ONLY');
  return user;
}

export async function requireAdmin(request: Request, store: Store): Promise<UserRecord> {
  const user = await requireUser(request, store);
  if (user.role !== 'admin') throw new AppError('FORBIDDEN');
  return user;
}

/**
 * Sign-in rate limiting, bucketed by email and by caller IP, each keyed by a
 * hash so the throttle table is not itself a list of who has an account.
 */
export async function withinRateLimit(store: Store, email: string, ip: string | null): Promise<boolean> {
  const emailOk = await store.throttle(`login:email:${hashToken(email)}`, LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_MS);
  const ipOk = ip
    ? await store.throttle(`login:ip:${hashToken(ip)}`, LOGIN_RATE_LIMIT * 4, LOGIN_RATE_WINDOW_MS)
    : true;
  return emailOk && ipOk;
}

/** The fields a browser may see about a user. Never the hash. */
export function publicUser(user: UserRecord) {
  return {
    userId: user.userId,
    email: user.email,
    name: user.name,
    role: user.role,
    active: user.active,
    mustChangePassword: user.mustChange,
    lastLoginAt: user.lastLoginAt,
  };
}
