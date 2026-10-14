import { randomUUID } from 'node:crypto';
import { issueSession } from '../src/lib/auth.ts';
import { SESSION_COOKIE } from '../src/lib/http.ts';
import { hashPassword } from '../src/lib/password.ts';
import type { Item, NodeItem } from '../src/domain/items.ts';
import type { Role, Store, UserRecord } from '../src/store/types.ts';

export const BASE = 'http://localhost:8888';

export async function makeUser(store: Store, role: Role = 'editor', password: string | null = null): Promise<UserRecord> {
  const user = await store.users.create({
    email: `${role}-${randomUUID().slice(0, 8)}@example.com`,
    name: `${role[0]!.toUpperCase()}${role.slice(1)} Person`,
    role,
    passwordHash: password ? await hashPassword(password) : null,
    mustChange: false,
  });
  if (!user) throw new Error('could not create test user');
  return user;
}

export function cookieFor(user: UserRecord): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(issueSession(user))}`;
}

export function get(path: string, cookie?: string): Request {
  return new Request(`${BASE}${path}`, { headers: cookie ? { cookie } : {} });
}

export function send(method: string, path: string, body: unknown, cookie?: string, contentType = 'application/json'): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { 'content-type': contentType, ...(cookie ? { cookie } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

let counter = 0;
export function sticky(overrides: Partial<NodeItem> = {}): Item {
  counter += 1;
  return {
    id: `n${counter}-${randomUUID().slice(0, 6)}`,
    kind: 'sticky',
    x: 0,
    y: 0,
    w: 160,
    h: 160,
    z: 1,
    text: 'note',
    color: '#fff1a8',
    size: 'M',
    owner: '',
    system: '',
    duration: '',
    notes: '',
    flag: '',
    ...overrides,
  };
}
