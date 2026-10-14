import { beforeEach, describe, expect, it } from 'vitest';
import { getStore, overrideStore } from '../src/domain/context.ts';
import { createMemoryStore, type MemoryStore } from '../src/store/memory.ts';
import { SESSION_COOKIE } from '../src/lib/http.ts';
import { cookieFor, get, makeUser, send, sticky } from './helpers.ts';

import loginHandler from '../netlify/functions/auth-login.ts';
import sessionHandler from '../netlify/functions/auth-session.ts';
import passwordHandler from '../netlify/functions/auth-password.ts';
import teamHandler from '../netlify/functions/team.ts';
import mapsHandler from '../netlify/functions/maps.ts';
import syncHandler from '../netlify/functions/map-sync.ts';
import healthHandler from '../netlify/functions/health.ts';

/**
 * The API as HTTP: status codes, cookies, and what each role can and cannot
 * do. These are the edges where a mistake leaks something or lets somebody
 * do what they should not.
 */

let store: MemoryStore;
beforeEach(() => {
  store = createMemoryStore();
  overrideStore(store);
});

const body = async (response: Response) => response.json() as Promise<Record<string, any>>;

async function newMap(cookie: string, extra: Record<string, unknown> = {}) {
  const response = await mapsHandler(send('POST', '/api/maps', { name: 'Timesheets', ...extra }, cookie));
  expect(response.status).toBe(201);
  return (await body(response)).map;
}

describe('sign in', () => {
  it('signs in with the right password and sets an HttpOnly cookie', async () => {
    const user = await makeUser(store, 'editor', 'correct horse battery');
    const response = await loginHandler(send('POST', '/api/auth/login', { email: user.email, password: 'correct horse battery' }));
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect((await body(response)).user).toMatchObject({ email: user.email, role: 'editor' });
    expect(JSON.stringify(await body(await sessionHandler(get('/api/auth/session', cookie.split(';')[0]))))).not.toContain('scrypt');
  });

  it('gives one answer for a wrong password, an unknown address and a deactivated account', async () => {
    const user = await makeUser(store, 'editor', 'correct horse battery');
    const gone = await makeUser(store, 'editor', 'correct horse battery');
    await store.users.update(gone.userId, { active: false });
    const attempts = [
      { email: user.email, password: 'wrong password!!' },
      { email: 'nobody@example.com', password: 'correct horse battery' },
      { email: gone.email, password: 'correct horse battery' },
    ];
    const answers = [];
    for (const attempt of attempts) {
      const response = await loginHandler(send('POST', '/api/auth/login', attempt));
      answers.push([response.status, (await body(response)).message]);
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]![0]).toBe(401);
  });

  it('rate limits repeated attempts on one address', async () => {
    const user = await makeUser(store, 'editor', 'correct horse battery');
    let last = 0;
    for (let i = 0; i < 9; i++) last = (await loginHandler(send('POST', '/api/auth/login', { email: user.email, password: 'nope nope nope' }))).status;
    expect(last).toBe(429);
  });

  it('creates and reconciles the bootstrap admin from the environment', async () => {
    process.env.ADMIN_BOOTSTRAP_EMAIL = 'boss@example.com';
    process.env.ADMIN_BOOTSTRAP_PASSWORD = 'bootstrap-password-123';
    try {
      const first = await loginHandler(send('POST', '/api/auth/login', { email: 'BOSS@example.com', password: 'bootstrap-password-123' }));
      expect(first.status).toBe(200);
      const admin = (await store.users.getByEmail('boss@example.com'))!;
      expect(admin).toMatchObject({ role: 'admin', active: true });
      // Demoted and deactivated by somebody: the next sign-in puts it right.
      await store.users.update(admin.userId, { role: 'viewer', active: false });
      expect((await loginHandler(send('POST', '/api/auth/login', { email: 'boss@example.com', password: 'bootstrap-password-123' }))).status).toBe(200);
      expect(await store.users.get(admin.userId)).toMatchObject({ role: 'admin', active: true });
    } finally {
      delete process.env.ADMIN_BOOTSTRAP_EMAIL;
      delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
    }
  });

  it('signs out by clearing the cookie', async () => {
    const response = await sessionHandler(send('POST', '/api/auth/session', {}));
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('stops honouring a cookie as soon as the account is deactivated', async () => {
    const user = await makeUser(store);
    const cookie = cookieFor(user);
    expect((await mapsHandler(get('/api/maps', cookie))).status).toBe(200);
    await store.users.update(user.userId, { active: false });
    expect((await mapsHandler(get('/api/maps', cookie))).status).toBe(401);
  });

  it('rejects a forged cookie', async () => {
    const user = await makeUser(store);
    const forged = cookieFor(user).replace(/\.[^.]+$/, '.forgedsignature');
    expect((await mapsHandler(get('/api/maps', forged))).status).toBe(401);
  });
});

describe('changing your password', () => {
  it('needs the current password and a long enough new one', async () => {
    const user = await makeUser(store, 'editor', 'temporary-password-1');
    const cookie = cookieFor(user);
    expect((await passwordHandler(send('POST', '/api/auth/password', { current: 'wrong', next: 'a brand new password' }, cookie))).status).toBe(401);
    expect((await passwordHandler(send('POST', '/api/auth/password', { current: 'temporary-password-1', next: 'short' }, cookie))).status).toBe(400);
    expect((await passwordHandler(send('POST', '/api/auth/password', { current: 'temporary-password-1', next: 'a brand new password' }, cookie))).status).toBe(200);
    expect(await store.users.get(user.userId)).toMatchObject({ mustChange: false });
    expect((await loginHandler(send('POST', '/api/auth/login', { email: user.email, password: 'a brand new password' }))).status).toBe(200);
  });
});

describe('the team', () => {
  it('is for admins only', async () => {
    const editor = await makeUser(store, 'editor');
    expect((await teamHandler(get('/api/team', cookieFor(editor)))).status).toBe(403);
    expect((await teamHandler(get('/api/team'))).status).toBe(401);
  });

  it('adds people with a one-time password they must change', async () => {
    const admin = await makeUser(store, 'admin');
    const response = await teamHandler(send('POST', '/api/team', { name: 'Nat Upston', email: 'Nat@Example.com', role: 'viewer' }, cookieFor(admin)));
    expect(response.status).toBe(201);
    const result = await body(response);
    expect(result.user).toMatchObject({ email: 'nat@example.com', role: 'viewer', mustChangePassword: true });
    expect(result.password).toMatch(/^[a-z2-9]{20}$/);
    const again = await teamHandler(send('POST', '/api/team', { name: 'Nat again', email: 'nat@example.com' }, cookieFor(admin)));
    expect(again.status).toBe(409);
    const login = await loginHandler(send('POST', '/api/auth/login', { email: 'nat@example.com', password: result.password }));
    expect((await body(login)).user).toMatchObject({ mustChangePassword: true });
  });

  it('will not let an admin remove their own access', async () => {
    const admin = await makeUser(store, 'admin');
    const response = await teamHandler(send('PATCH', `/api/team/${admin.userId}`, { role: 'editor' }, cookieFor(admin)));
    expect(response.status).toBe(409);
    expect((await teamHandler(send('PATCH', `/api/team/${admin.userId}`, { active: false }, cookieFor(admin)))).status).toBe(409);
  });

  it('resets a password, and the old one stops working', async () => {
    const admin = await makeUser(store, 'admin');
    const person = await makeUser(store, 'editor', 'old-password-12345');
    const result = await body(await teamHandler(send('PATCH', `/api/team/${person.userId}`, { resetPassword: true }, cookieFor(admin))));
    expect(result.password).toBeTruthy();
    expect((await loginHandler(send('POST', '/api/auth/login', { email: person.email, password: 'old-password-12345' }))).status).toBe(401);
    expect((await loginHandler(send('POST', '/api/auth/login', { email: person.email, password: result.password }))).status).toBe(200);
  });

  it('answers 404, not 500, for a malformed id', async () => {
    const admin = await makeUser(store, 'admin');
    expect((await teamHandler(send('PATCH', '/api/team/not-a-uuid', { role: 'viewer' }, cookieFor(admin)))).status).toBe(404);
  });
});

describe('maps', () => {
  it('need a signed-in user', async () => {
    expect((await mapsHandler(get('/api/maps'))).status).toBe(401);
    expect((await syncHandler(send('POST', '/api/maps/00000000-0000-4000-8000-000000000000/sync', { since: 0 }))).status).toBe(401);
  });

  it('refuse writes that are not JSON, which is what keeps cross-site forms out', async () => {
    const user = await makeUser(store);
    const response = await mapsHandler(send('POST', '/api/maps', 'name=Evil', cookieFor(user), 'application/x-www-form-urlencoded'));
    expect(response.status).toBe(400);
    expect(store._maps.size).toBe(0);
  });

  it('are created from a template and loaded with their items', async () => {
    const user = await makeUser(store);
    const map = await newMap(cookieFor(user), { template: 'swimlane', area: 'Workforce' });
    expect(map).toMatchObject({ name: 'Timesheets', area: 'Workforce', status: 'draft' });
    const loaded = await body(await mapsHandler(get(`/api/maps/${map.mapId}`, cookieFor(user))));
    expect(loaded.items.filter((i: any) => i.kind === 'lane')).toHaveLength(3);
    expect(loaded.canEdit).toBe(true);
    expect((await mapsHandler(send('POST', '/api/maps', { name: 'x', template: 'nope' }, cookieFor(user)))).status).toBe(400);
  });

  it('answer 404, not 500, for a malformed or unknown id', async () => {
    const user = await makeUser(store);
    expect((await mapsHandler(get('/api/maps/not-a-uuid', cookieFor(user)))).status).toBe(404);
    expect((await mapsHandler(get('/api/maps/%E0%A4%A', cookieFor(user)))).status).toBe(404);
    expect((await mapsHandler(get('/api/maps/00000000-0000-4000-8000-000000000000', cookieFor(user)))).status).toBe(404);
  });

  it('can be renamed, given a status, archived and restored', async () => {
    const user = await makeUser(store);
    const map = await newMap(cookieFor(user));
    const patched = await body(await mapsHandler(send('PATCH', `/api/maps/${map.mapId}`, { name: 'Timesheets v2', status: 'in_review' }, cookieFor(user))));
    expect(patched.map).toMatchObject({ name: 'Timesheets v2', status: 'in_review' });
    expect((await mapsHandler(send('PATCH', `/api/maps/${map.mapId}`, { status: 'done' }, cookieFor(user)))).status).toBe(400);
    await mapsHandler(send('PATCH', `/api/maps/${map.mapId}`, { archived: true }, cookieFor(user)));
    expect((await body(await mapsHandler(get('/api/maps', cookieFor(user))))).maps).toHaveLength(0);
    expect((await body(await mapsHandler(get('/api/maps?archived=1', cookieFor(user))))).maps).toHaveLength(1);
  });

  it('can be duplicated with everything on them', async () => {
    const user = await makeUser(store);
    const map = await newMap(cookieFor(user), { template: 'as-is-to-be' });
    const copy = (await body(await mapsHandler(send('POST', `/api/maps/${map.mapId}/duplicate`, {}, cookieFor(user))))).map;
    expect(copy).toMatchObject({ name: 'Copy of Timesheets', itemCount: map.itemCount });
    expect(copy.mapId).not.toBe(map.mapId);
  });
});

describe('sync', () => {
  async function sync(mapId: string, cookie: string, payload: Record<string, unknown>): Promise<Record<string, any>> {
    const response = await syncHandler(send('POST', `/api/maps/${mapId}/sync`, payload, cookie));
    return { status: response.status, ...(await body(response)) };
  }

  it('sends one person\'s edits to another, including deletes', async () => {
    const a = await makeUser(store);
    const b = await makeUser(store);
    const map = await newMap(cookieFor(a));
    const note = sticky({ text: 'from A' });

    const pushed = await sync(map.mapId, cookieFor(a), { since: 0, ops: [{ type: 'put', item: note }] });
    expect(pushed).toMatchObject({ status: 200, revision: 1 });

    const pulled = await sync(map.mapId, cookieFor(b), { since: 0 });
    expect(pulled.items).toEqual([{ id: note.id, item: expect.objectContaining({ text: 'from A' }), deleted: false }]);

    await sync(map.mapId, cookieFor(a), { since: 1, ops: [{ type: 'delete', id: note.id }] });
    const later = await sync(map.mapId, cookieFor(b), { since: pulled.revision });
    expect(later.items).toEqual([{ id: note.id, item: null, deleted: true }]);
  });

  it('shows who else is on the board and what they have selected, never yourself', async () => {
    const a = await makeUser(store);
    const b = await makeUser(store);
    const map = await newMap(cookieFor(a));
    await sync(map.mapId, cookieFor(a), { since: 0, client: 'tabA', selection: ['abc', 'not valid id!'] });
    const seen = await sync(map.mapId, cookieFor(b), { since: 0, client: 'tabB' });
    expect(seen.presence).toEqual([{ userId: a.userId, clientId: 'tabA', name: a.name, selection: ['abc'] }]);
    const own = await sync(map.mapId, cookieFor(a), { since: 0 });
    expect(own.presence.map((p: any) => p.userId)).toEqual([b.userId]);
  });

  it('lets viewers read but not write', async () => {
    const editor = await makeUser(store);
    const viewer = await makeUser(store, 'viewer');
    const map = await newMap(cookieFor(editor));
    expect((await sync(map.mapId, cookieFor(viewer), { since: 0 })).status).toBe(200);
    const refused = await sync(map.mapId, cookieFor(viewer), { since: 0, ops: [{ type: 'put', item: sticky() }] });
    expect(refused).toMatchObject({ status: 403, code: 'READ_ONLY' });
    expect((await mapsHandler(send('POST', '/api/maps', { name: 'Nope' }, cookieFor(viewer)))).status).toBe(403);
    expect((await body(await mapsHandler(get(`/api/maps/${map.mapId}`, cookieFor(viewer))))).canEdit).toBe(false);
  });

  it('refuses edits to an archived map', async () => {
    const user = await makeUser(store);
    const map = await newMap(cookieFor(user));
    await mapsHandler(send('PATCH', `/api/maps/${map.mapId}`, { archived: true }, cookieFor(user)));
    const refused = await sync(map.mapId, cookieFor(user), { since: 0, ops: [{ type: 'put', item: sticky() }] });
    expect(refused).toMatchObject({ status: 409, code: 'MAP_ARCHIVED' });
    expect((await sync(map.mapId, cookieFor(user), { since: 0 })).canEdit).toBe(false);
  });

  it('sends the whole board again to a browser that is ahead of the server', async () => {
    const user = await makeUser(store);
    const map = await newMap(cookieFor(user), { template: 'swimlane' });
    const ahead = await sync(map.mapId, cookieFor(user), { since: 999 });
    expect(ahead.reset).toBe(true);
    expect(ahead.items.length).toBeGreaterThan(5);
  });

  it('stores a valid thumbnail from an editor and drops a malformed one', async () => {
    const user = await makeUser(store);
    const map = await newMap(cookieFor(user));
    const preview = { w: 1000, h: 400, shapes: [['p', 0, 0, 100, 50, '#ffffff'], ['p', 0, 0, 1, 1, 'javascript:'], ['q', 0, 0, 1, 1, '#000000']], links: [[0, 0, 100, 100]] };
    await sync(map.mapId, cookieFor(user), { since: 0, preview });
    const stored = (await store.maps.get(map.mapId))!.preview!;
    expect(stored.shapes).toEqual([['p', 0, 0, 100, 50, '#ffffff']]);
    await sync(map.mapId, cookieFor(user), { since: 0, preview: '<svg onload=alert(1)>' });
    expect((await store.maps.get(map.mapId))!.preview).toEqual(stored);
  });

  it('rejects a malformed request rather than guessing', async () => {
    const user = await makeUser(store);
    const map = await newMap(cookieFor(user));
    expect((await sync(map.mapId, cookieFor(user), { since: -1 })).status).toBe(400);
    expect((await sync(map.mapId, cookieFor(user), { since: 0, ops: [{ type: 'put', item: { id: 'a', kind: 'script' } }] })).status).toBe(400);
  });
});

describe('health', () => {
  it('reports what a fresh deploy still needs', async () => {
    const response = await healthHandler();
    const result = await body(response);
    expect(response.status).toBe(503);
    expect(result.checks.admin.ok).toBe(false);
    await makeUser(store, 'admin');
    expect((await healthHandler()).status).toBe(200);
  });
});

describe('with no database', () => {
  it('refuses to run on a store that would forget everything, unless asked by name', async () => {
    overrideStore(null);
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await expect(getStore()).rejects.toThrow('No database configured');
      const response = await healthHandler();
      expect(response.status).toBe(503);
      expect((await body(response)).checks.database.note).toContain('Enable Netlify DB');
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
      overrideStore(null);
    }
  });
});
