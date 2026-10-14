import { randomUUID } from 'node:crypto';
import type { Item, ItemOp } from '../domain/items.ts';
import type { ApplyResult, ItemRow, MapPatch, MapRecord, PresenceRow, Store, UserRecord } from './types.ts';

/**
 * In-memory store. Backs the test suite and local work with no database.
 * Nothing persists past the process, and production refuses to start with it
 * (see domain/context.ts).
 */

interface MemItem {
  item: Item | null;
  id: string;
  revision: number;
  deleted: boolean;
  updatedBy: string;
}

interface MemMap extends Omit<MapRecord, 'createdByName' | 'updatedByName' | 'itemCount'> {
  items: Map<string, MemItem>;
  presence: Map<string, { userId: string; clientId: string; seenAt: number; selection: string[] }>;
}

export interface MemoryStore extends Store {
  /** Test seam: the raw state. */
  readonly _maps: Map<string, MemMap>;
  readonly _users: Map<string, UserRecord>;
}

const clone = <T>(value: T): T => structuredClone(value);

export function createMemoryStore(): MemoryStore {
  const users = new Map<string, UserRecord>();
  const maps = new Map<string, MemMap>();
  const throttles = new Map<string, { hits: number; windowStart: number }>();

  const nameOf = (userId: string | null) => (userId ? users.get(userId)?.name ?? null : null);
  const liveCount = (map: MemMap) => [...map.items.values()].filter((i) => !i.deleted).length;

  function toRecord(map: MemMap): MapRecord {
    const { items: _items, presence: _presence, ...rest } = map;
    return {
      ...rest,
      itemCount: liveCount(map),
      createdByName: nameOf(map.createdBy),
      updatedByName: nameOf(map.updatedBy),
    };
  }

  return {
    _maps: maps,
    _users: users,

    users: {
      async get(userId) {
        const user = users.get(userId);
        return user ? clone(user) : null;
      },
      async getByEmail(email) {
        const lower = email.toLowerCase();
        for (const user of users.values()) if (user.email.toLowerCase() === lower) return clone(user);
        return null;
      },
      async list() {
        return [...users.values()]
          .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name))
          .map(clone);
      },
      async create(input) {
        const lower = input.email.toLowerCase();
        for (const user of users.values()) if (user.email.toLowerCase() === lower) return null;
        const user: UserRecord = {
          userId: randomUUID(),
          email: input.email,
          name: input.name,
          role: input.role,
          active: true,
          mustChange: input.mustChange,
          sessionVersion: 0,
          passwordHash: input.passwordHash,
          lastLoginAt: null,
          createdAt: new Date().toISOString(),
        };
        users.set(user.userId, user);
        return clone(user);
      },
      async update(userId, patch) {
        const user = users.get(userId);
        if (!user) return null;
        if (patch.name !== undefined) user.name = patch.name;
        if (patch.role !== undefined) user.role = patch.role;
        if (patch.active !== undefined) user.active = patch.active;
        return clone(user);
      },
      async setPassword(userId, passwordHash, mustChange) {
        const user = users.get(userId);
        if (!user) return;
        user.passwordHash = passwordHash;
        user.mustChange = mustChange;
        user.sessionVersion += 1;
      },
      async recordLogin(userId) {
        const user = users.get(userId);
        if (user) user.lastLoginAt = new Date().toISOString();
      },
    },

    async throttle(bucketKey, limit, windowMs) {
      const now = Date.now();
      const entry = throttles.get(bucketKey);
      if (!entry || entry.windowStart < now - windowMs) {
        throttles.set(bucketKey, { hits: 1, windowStart: now });
        return 1 <= limit;
      }
      entry.hits += 1;
      return entry.hits <= limit;
    },

    maps: {
      async list({ archived }) {
        return [...maps.values()]
          .filter((m) => (m.archivedAt !== null) === archived)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map(toRecord);
      },
      async get(mapId) {
        const map = maps.get(mapId);
        return map ? toRecord(map) : null;
      },
      async create({ name, area, description, userId, items }) {
        const now = new Date().toISOString();
        const map: MemMap = {
          mapId: randomUUID(),
          name,
          area,
          description,
          status: 'draft',
          revision: items.length ? 1 : 0,
          createdBy: userId,
          updatedBy: userId,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          preview: null,
          items: new Map(),
          presence: new Map(),
        };
        for (const item of items) {
          map.items.set(item.id, { item: clone(item), id: item.id, revision: 1, deleted: false, updatedBy: userId });
        }
        maps.set(map.mapId, map);
        return toRecord(map);
      },
      async update(mapId, patch: MapPatch, userId) {
        const map = maps.get(mapId);
        if (!map) return null;
        if (patch.name !== undefined) map.name = patch.name;
        if (patch.area !== undefined) map.area = patch.area;
        if (patch.description !== undefined) map.description = patch.description;
        if (patch.status !== undefined) map.status = patch.status;
        if (patch.archived !== undefined) map.archivedAt = patch.archived ? map.archivedAt ?? new Date().toISOString() : null;
        map.updatedBy = userId;
        map.updatedAt = new Date().toISOString();
        return toRecord(map);
      },
      async items(mapId, sinceRevision) {
        const map = maps.get(mapId);
        if (!map) return [];
        const rows: ItemRow[] = [];
        for (const row of map.items.values()) {
          if (row.revision <= sinceRevision) continue;
          if (sinceRevision === 0 && row.deleted) continue;
          rows.push({ id: row.id, item: row.item ? clone(row.item) : null, revision: row.revision, deleted: row.deleted });
        }
        return rows.sort((a, b) => a.revision - b.revision);
      },
      async apply(mapId, ops: ItemOp[], userId, maxItems): Promise<ApplyResult> {
        const map = maps.get(mapId);
        if (!map) return { ok: false, code: 'NOT_FOUND' };
        if (map.archivedAt) return { ok: false, code: 'MAP_ARCHIVED' };
        let live = liveCount(map);
        for (const op of ops) {
          const existing = map.items.get(op.type === 'put' ? op.item.id : op.id);
          const wasLive = Boolean(existing && !existing.deleted);
          if (op.type === 'put' && wasLive && (existing!.item!.kind === 'connector') !== (op.item.kind === 'connector')) {
            return { ok: false, code: 'INVALID_REQUEST' };
          }
          if (op.type === 'put' && !wasLive) live += 1;
          if (op.type === 'delete' && wasLive) live -= 1;
        }
        if (live > maxItems) return { ok: false, code: 'MAP_FULL' };

        const revision = map.revision + 1;
        for (const op of ops) {
          if (op.type === 'put') {
            map.items.set(op.item.id, { item: clone(op.item), id: op.item.id, revision, deleted: false, updatedBy: userId });
          } else {
            // Deleting something this store never saw still records a
            // tombstone: another browser may hold it from a paste in flight.
            map.items.set(op.id, { item: null, id: op.id, revision, deleted: true, updatedBy: userId });
          }
        }
        map.revision = revision;
        map.updatedBy = userId;
        map.updatedAt = new Date().toISOString();
        return { ok: true, revision };
      },
      async setPreview(mapId, preview) {
        const map = maps.get(mapId);
        if (map) map.preview = clone(preview);
      },
      async touchPresence(mapId, userId, clientId, selection) {
        maps.get(mapId)?.presence.set(`${userId}/${clientId}`, { userId, clientId, seenAt: Date.now(), selection: [...selection] });
      },
      async presence(mapId, withinMs): Promise<PresenceRow[]> {
        const map = maps.get(mapId);
        if (!map) return [];
        const cutoff = Date.now() - withinMs;
        const rows: PresenceRow[] = [];
        for (const entry of map.presence.values()) {
          if (entry.seenAt < cutoff) continue;
          rows.push({
            userId: entry.userId,
            clientId: entry.clientId,
            name: nameOf(entry.userId) ?? 'Someone',
            selection: [...entry.selection],
            seenAt: new Date(entry.seenAt).toISOString(),
          });
        }
        return rows;
      },
    },
  };
}
