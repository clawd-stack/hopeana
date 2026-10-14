import type { Item, ItemOp } from '../domain/items.ts';

/**
 * Store interfaces. Everything above this layer talks to these types, never
 * to SQL. pg.ts is production; memory.ts backs the test suite and local work
 * without a database. Both are held to the same tests.
 */

export type Role = 'admin' | 'editor' | 'viewer';
export const ROLES: readonly Role[] = ['admin', 'editor', 'viewer'];

export type MapStatus = 'draft' | 'in_review' | 'agreed';
export const MAP_STATUSES: readonly MapStatus[] = ['draft', 'in_review', 'agreed'];

export interface UserRecord {
  userId: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  mustChange: boolean;
  /** In every session cookie; bumped by setPassword, which ends older sessions. */
  sessionVersion: number;
  passwordHash: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface MapRecord {
  mapId: string;
  name: string;
  area: string;
  description: string;
  status: MapStatus;
  revision: number;
  itemCount: number;
  preview: MapPreview | null;
  createdBy: string | null;
  createdByName: string | null;
  updatedBy: string | null;
  updatedByName: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

/** Thumbnail geometry, normalised so the longer side spans 0..1000. */
export interface MapPreview {
  w: number;
  h: number;
  shapes: [string, number, number, number, number, string][];
  links: [number, number, number, number][];
}

export interface ItemRow {
  item: Item | null;
  id: string;
  revision: number;
  deleted: boolean;
}

export interface PresenceRow {
  userId: string;
  clientId: string;
  name: string;
  selection: string[];
  seenAt: string;
}

export interface MapPatch {
  name?: string;
  area?: string;
  description?: string;
  status?: MapStatus;
  archived?: boolean;
}

/** A write refused inside the store's transaction, so nothing was applied. */
export type ApplyResult =
  | { ok: true; revision: number }
  /** INVALID_REQUEST: a put would turn a live step into a connector or back. */
  | { ok: false; code: 'NOT_FOUND' | 'MAP_ARCHIVED' | 'MAP_FULL' | 'INVALID_REQUEST' };

export interface Store {
  users: {
    get(userId: string): Promise<UserRecord | null>;
    getByEmail(email: string): Promise<UserRecord | null>;
    list(): Promise<UserRecord[]>;
    /** Null when the address is already taken. */
    create(input: { email: string; name: string; role: Role; passwordHash: string | null; mustChange: boolean }): Promise<UserRecord | null>;
    update(userId: string, patch: { name?: string; role?: Role; active?: boolean }): Promise<UserRecord | null>;
    /** Also bumps sessionVersion, signing out every existing session. */
    setPassword(userId: string, passwordHash: string, mustChange: boolean): Promise<void>;
    recordLogin(userId: string): Promise<void>;
  };
  /** True while the bucket is under its limit for the window. */
  throttle(bucketKey: string, limit: number, windowMs: number): Promise<boolean>;
  maps: {
    list(options: { archived: boolean }): Promise<MapRecord[]>;
    get(mapId: string): Promise<MapRecord | null>;
    create(input: { name: string; area: string; description: string; userId: string; items: Item[] }): Promise<MapRecord>;
    update(mapId: string, patch: MapPatch, userId: string): Promise<MapRecord | null>;
    /**
     * Items changed after a revision. From revision 0 this is the live board
     * and leaves tombstones out; from any later revision it includes them, so
     * a browser learns what was deleted while it was away.
     */
    items(mapId: string, sinceRevision: number): Promise<ItemRow[]>;
    /** Applies a batch atomically under the board lock, stamping one new revision. */
    apply(mapId: string, ops: ItemOp[], userId: string, maxItems: number): Promise<ApplyResult>;
    setPreview(mapId: string, preview: MapPreview): Promise<void>;
    /** One row per browser tab: clientId is random per page load. */
    touchPresence(mapId: string, userId: string, clientId: string, selection: string[]): Promise<void>;
    presence(mapId: string, withinMs: number): Promise<PresenceRow[]>;
  };
}
