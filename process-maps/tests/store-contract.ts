import { afterAll, describe, expect, it } from 'vitest';
import type { Store } from '../src/store/types.ts';
import { sanitiseItem, type Item } from '../src/domain/items.ts';
import { makeUser, sticky } from './helpers.ts';

/**
 * What every store must do, run against the in-memory store always and
 * against Postgres when DATABASE_URL is set. The revision rules are the whole
 * basis of collaboration, so they are pinned down here rather than assumed.
 */
export function storeContract(name: string, make: () => Store, teardown?: () => Promise<void>) {
  describe(`${name} store`, () => {
    const store = make();
    if (teardown) afterAll(teardown);

    it('creates users with unique, case-insensitive emails', async () => {
      const user = await makeUser(store);
      expect(await store.users.getByEmail(user.email!.toUpperCase())).toMatchObject({ userId: user.userId });
      const clash = await store.users.create({ email: user.email!.toUpperCase(), name: 'Clash', role: 'viewer', passwordHash: null, mustChange: true });
      expect(clash).toBeNull();
    });

    it('updates role and active state, and sets passwords', async () => {
      const user = await makeUser(store);
      expect(await store.users.update(user.userId, { role: 'viewer', active: false })).toMatchObject({ role: 'viewer', active: false, name: user.name });
      await store.users.setPassword(user.userId, 'scrypt$hash', true);
      expect(await store.users.get(user.userId)).toMatchObject({ passwordHash: 'scrypt$hash', mustChange: true });
    });

    it('keeps agents without an email, finds them by key hash, and replaces keys', async () => {
      const a = await store.users.create({ email: null, name: 'Bot A', role: 'editor', passwordHash: null, mustChange: false, isAgent: true });
      const b = await store.users.create({ email: null, name: 'Bot B', role: 'viewer', passwordHash: null, mustChange: false, isAgent: true });
      expect(a).toMatchObject({ email: null, isAgent: true, apiKeyCreatedAt: null });
      expect(b).not.toBeNull();
      const hashA = `hash-a-${Math.random()}`;
      await store.users.setApiKey(a!.userId, hashA);
      expect(await store.users.getByApiKey(hashA)).toMatchObject({ userId: a!.userId, isAgent: true });
      expect((await store.users.get(a!.userId))!.apiKeyCreatedAt).not.toBeNull();
      const replaced = `hash-a2-${Math.random()}`;
      await store.users.setApiKey(a!.userId, replaced);
      expect(await store.users.getByApiKey(hashA)).toBeNull();
      expect(await store.users.getByApiKey(replaced)).toMatchObject({ userId: a!.userId });
      expect(await store.users.getByApiKey('no-such-hash')).toBeNull();
      expect((await makeUser(store)).isAgent).toBe(false);
    });

    it('throttles a bucket once it passes its limit', async () => {
      const bucket = `test:${Math.random()}`;
      const results = [];
      for (let i = 0; i < 4; i++) results.push(await store.throttle(bucket, 3, 60_000));
      expect(results).toEqual([true, true, true, false]);
    });

    it('creates a map with its starting items at revision 1', async () => {
      const user = await makeUser(store);
      const items = [sticky(), sticky()];
      const map = await store.maps.create({ name: 'Onboarding', area: 'Workforce', description: '', userId: user.userId, items });
      expect(map).toMatchObject({ name: 'Onboarding', area: 'Workforce', status: 'draft', revision: 1, itemCount: 2, createdByName: user.name });
      expect((await store.maps.items(map.mapId, 0)).map((r) => r.id).sort()).toEqual(items.map((i) => i.id).sort());
    });

    it('stamps every write with the next revision and reports changes since any revision', async () => {
      const user = await makeUser(store);
      const map = await store.maps.create({ name: 'Rev', area: '', description: '', userId: user.userId, items: [] });
      const a = sticky();
      const b = sticky();
      expect(await store.maps.apply(map.mapId, [{ type: 'put', item: a }], user.userId, 100)).toEqual({ ok: true, revision: 1 });
      expect(await store.maps.apply(map.mapId, [{ type: 'put', item: b }], user.userId, 100)).toEqual({ ok: true, revision: 2 });
      expect(await store.maps.apply(map.mapId, [{ type: 'delete', id: a.id }], user.userId, 100)).toEqual({ ok: true, revision: 3 });

      const live = await store.maps.items(map.mapId, 0);
      expect(live.map((r) => r.id)).toEqual([b.id]);

      const since1 = await store.maps.items(map.mapId, 1);
      expect(since1.map((r) => [r.id, r.revision, r.deleted])).toEqual([[b.id, 2, false], [a.id, 3, true]]);
      expect(since1[1]!.item).toBeNull();

      expect(await store.maps.items(map.mapId, 3)).toEqual([]);
      expect(await store.maps.get(map.mapId)).toMatchObject({ revision: 3, itemCount: 1, updatedByName: user.name });
    });

    it('stores text that has been through the item check, whatever was typed', async () => {
      const user = await makeUser(store);
      const map = await store.maps.create({ name: 'Odd text', area: '', description: '', userId: user.userId, items: [] });
      const item = sanitiseItem({ ...sticky(), text: `nul\u0000 and half \u{1F600}`.slice(0, -1) });
      expect(await store.maps.apply(map.mapId, [{ type: 'put', item }], user.userId, 100)).toMatchObject({ ok: true });
      expect((await store.maps.items(map.mapId, 0))[0]!.item).toMatchObject({ text: 'nul and half \uFFFD' });
    });

    it('refuses to turn a live step into a connector, or back', async () => {
      const user = await makeUser(store);
      const note = sticky();
      const map = await store.maps.create({ name: 'Kinds', area: '', description: '', userId: user.userId, items: [note] });
      const asConnector = { id: note.id, kind: 'connector' as const, z: 0, from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, text: '', color: '#4b5563', dashed: false, arrow: 'end' as const, route: 'elbow' as const };
      expect(await store.maps.apply(map.mapId, [{ type: 'put', item: asConnector }], user.userId, 100)).toEqual({ ok: false, code: 'INVALID_REQUEST' });
      // A step changing shape is fine, and so is reusing a deleted id.
      expect(await store.maps.apply(map.mapId, [{ type: 'put', item: { ...note, kind: 'decision' } as Item }], user.userId, 100)).toMatchObject({ ok: true });
      await store.maps.apply(map.mapId, [{ type: 'delete', id: note.id }], user.userId, 100);
      expect(await store.maps.apply(map.mapId, [{ type: 'put', item: asConnector }], user.userId, 100)).toMatchObject({ ok: true });
    });

    it('ends existing sessions when a password is set', async () => {
      const user = await makeUser(store);
      await store.users.setPassword(user.userId, 'scrypt$x', false);
      expect((await store.users.get(user.userId))!.sessionVersion).toBe(user.sessionVersion + 1);
    });

    it('lets the last write to an item win', async () => {
      const user = await makeUser(store);
      const map = await store.maps.create({ name: 'LWW', area: '', description: '', userId: user.userId, items: [] });
      const item = sticky({ text: 'first' });
      await store.maps.apply(map.mapId, [{ type: 'put', item }], user.userId, 100);
      await store.maps.apply(map.mapId, [{ type: 'put', item: { ...item, text: 'second' } }], user.userId, 100);
      const rows = await store.maps.items(map.mapId, 0);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.item).toMatchObject({ text: 'second' });
    });

    it('refuses writes that would pass the size limit, without applying any of them', async () => {
      const user = await makeUser(store);
      const map = await store.maps.create({ name: 'Full', area: '', description: '', userId: user.userId, items: [sticky(), sticky()] });
      const result = await store.maps.apply(map.mapId, [{ type: 'put', item: sticky() }, { type: 'put', item: sticky() }], user.userId, 3);
      expect(result).toEqual({ ok: false, code: 'MAP_FULL' });
      expect(await store.maps.get(map.mapId)).toMatchObject({ revision: 1, itemCount: 2 });
      // Replacing an existing item does not grow the board.
      const [first] = await store.maps.items(map.mapId, 0);
      expect(await store.maps.apply(map.mapId, [{ type: 'put', item: { ...first!.item!, text: 'edited' } }, { type: 'put', item: sticky() }], user.userId, 3)).toMatchObject({ ok: true });
    });

    it('refuses writes to archived and missing maps', async () => {
      const user = await makeUser(store);
      const map = await store.maps.create({ name: 'Old', area: '', description: '', userId: user.userId, items: [] });
      await store.maps.update(map.mapId, { archived: true }, user.userId);
      expect(await store.maps.apply(map.mapId, [{ type: 'put', item: sticky() }], user.userId, 100)).toEqual({ ok: false, code: 'MAP_ARCHIVED' });
      expect(await store.maps.apply('00000000-0000-4000-8000-000000000000', [], user.userId, 100)).toEqual({ ok: false, code: 'NOT_FOUND' });
    });

    it('lists active and archived maps separately, newest edit first', async () => {
      const user = await makeUser(store);
      const older = await store.maps.create({ name: 'Older', area: '', description: '', userId: user.userId, items: [] });
      await new Promise((r) => setTimeout(r, 15));
      const newer = await store.maps.create({ name: 'Newer', area: '', description: '', userId: user.userId, items: [] });
      const archived = await store.maps.create({ name: 'Gone', area: '', description: '', userId: user.userId, items: [] });
      await store.maps.update(archived.mapId, { archived: true }, user.userId);
      const active = (await store.maps.list({ archived: false })).map((m) => m.mapId);
      expect(active.indexOf(newer.mapId)).toBeLessThan(active.indexOf(older.mapId));
      expect(active).not.toContain(archived.mapId);
      expect((await store.maps.list({ archived: true })).map((m) => m.mapId)).toContain(archived.mapId);
      expect(await store.maps.update(archived.mapId, { archived: false, name: 'Back', status: 'agreed' }, user.userId)).toMatchObject({ archivedAt: null, name: 'Back', status: 'agreed' });
    });

    it('records presence and forgets it after the window', async () => {
      const a = await makeUser(store);
      const b = await makeUser(store);
      const map = await store.maps.create({ name: 'Here', area: '', description: '', userId: a.userId, items: [] });
      await store.maps.touchPresence(map.mapId, a.userId, 'tab1', ['x1']);
      await store.maps.touchPresence(map.mapId, b.userId, 'tab2', []);
      // The same person in a second tab is a second presence, and an idle
      // tab must not wipe the selection made in the busy one.
      await store.maps.touchPresence(map.mapId, a.userId, 'tab3', []);
      await store.maps.touchPresence(map.mapId, a.userId, 'tab1', ['x1', 'x2']);
      const rows = await store.maps.presence(map.mapId, 30_000);
      expect(rows.map((r) => r.name).sort()).toEqual([a.name, a.name, b.name].sort());
      expect(rows.find((r) => r.clientId === 'tab1')!.selection).toEqual(['x1', 'x2']);
      expect(rows.find((r) => r.clientId === 'tab3')!.selection).toEqual([]);
      await new Promise((r) => setTimeout(r, 30));
      expect(await store.maps.presence(map.mapId, 10)).toEqual([]);
    });

    it('stores a thumbnail preview', async () => {
      const user = await makeUser(store);
      const map = await store.maps.create({ name: 'Thumb', area: '', description: '', userId: user.userId, items: [] });
      const preview = { w: 100, h: 50, shapes: [['p', 0, 0, 10, 10, '#ffffff']] as [string, number, number, number, number, string][], links: [] };
      await store.maps.setPreview(map.mapId, preview);
      expect((await store.maps.get(map.mapId))!.preview).toEqual(preview);
    });

    it('orders concurrent writes so no reader ever misses a change', async () => {
      const user = await makeUser(store);
      const map = await store.maps.create({ name: 'Busy', area: '', description: '', userId: user.userId, items: [] });
      const writes = Array.from({ length: 20 }, () => store.maps.apply(map.mapId, [{ type: 'put', item: sticky() }], user.userId, 100));
      // A reader polling while the writes land.
      const seen = new Set<string>();
      let since = 0;
      const reader = (async () => {
        for (let i = 0; i < 30; i++) {
          for (const row of await store.maps.items(map.mapId, since)) {
            seen.add(row.id);
            since = Math.max(since, row.revision);
          }
          await new Promise((r) => setTimeout(r, 2));
        }
      })();
      const results = await Promise.all(writes);
      await reader;
      for (const row of await store.maps.items(map.mapId, since)) seen.add(row.id);
      const revisions = results.map((r) => (r.ok ? r.revision : -1)).sort((a, b) => a - b);
      expect(revisions).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      expect(seen.size).toBe(20);
    });
  });
}
