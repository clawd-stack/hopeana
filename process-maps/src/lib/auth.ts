import { AppError } from './errors.ts';
import { env } from './env.ts';
import { SESSION_COOKIE, readCookie } from './http.ts';
import { generateToken, hashToken, signSession, verifySession } from './crypto.ts';
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
 *
 * Agents (Crocbot, a Claude agent, a script) do not have cookies. They send
 * an access key, `Authorization: Bearer pmk_...`, which an admin makes on the
 * Team page. A request carrying a key is that agent and nobody else: it never
 * falls back to a cookie, so a key can never borrow a person's session. Inside
 * Peggy this part can stay as it is, keyed to Peggy's users table.
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

export const API_KEY_PREFIX = 'pmk_';
/** How stale an agent's "last active" may get before a request refreshes it. */
const ACTIVITY_REFRESH_MS = 5 * 60_000;

/** A new access key: shown once, stored only as its SHA-256. */
export function newApiKey(): { key: string; hash: string } {
  const key = `${API_KEY_PREFIX}${generateToken(32)}`;
  return { key, hash: hashToken(key) };
}

/**
 * The access key a request carries, if any. `?key=` is only read where the
 * endpoint allows it (the agent API and MCP, for agents that cannot set a
 * header), because a key in a URL can end up in logs.
 */
export function readApiKey(request: Request, { allowQuery = false } = {}): string | null {
  // Only the Bearer scheme is a key. Anything else (Basic, from a password-
  // protected deploy) is left alone so the cookie still works behind it.
  const header = request.headers.get('authorization');
  if (header && /^Bearer\s/i.test(header)) return header.replace(/^Bearer\s+/i, '').trim();
  if (allowQuery) return new URL(request.url).searchParams.get('key') || null;
  return null;
}

async function agentFromKey(store: Store, key: string): Promise<UserRecord | null> {
  if (!key.startsWith(API_KEY_PREFIX) || key.length > 200) return null;
  const user = await store.users.getByApiKey(hashToken(key));
  if (!user || !user.active || !user.isAgent) return null;
  if (!user.lastLoginAt || Date.now() - Date.parse(user.lastLoginAt) > ACTIVITY_REFRESH_MS) {
    await store.users.recordLogin(user.userId);
  }
  return user;
}

/**
 * The signed-in user, or null. A cookie from before a password change no
 * longer counts. A request with a key is the key's agent or nobody.
 */
export async function currentUser(request: Request, store: Store, { allowQueryKey = false } = {}): Promise<UserRecord | null> {
  const key = readApiKey(request, { allowQuery: allowQueryKey });
  if (key !== null) return agentFromKey(store, key);
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
 * An agent, by its key and nothing else: the agent API and MCP never accept a
 * cookie, so a page on another site cannot make a person's browser call them.
 */
export async function requireAgent(request: Request, store: Store): Promise<UserRecord> {
  const key = readApiKey(request, { allowQuery: true });
  if (!key) throw new AppError('UNAUTHENTICATED', null, 'Send your access key as "Authorization: Bearer pmk_...". An admin makes one on the Team page.');
  const user = await agentFromKey(store, key);
  if (!user) throw new AppError('UNAUTHENTICATED', null, 'That access key is not valid. It may have been replaced, or the agent switched off. Ask an admin for a new one.');
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
    isAgent: user.isAgent,
    active: user.active,
    mustChangePassword: user.mustChange,
    lastLoginAt: user.lastLoginAt,
    apiKeyCreatedAt: user.apiKeyCreatedAt,
  };
}
