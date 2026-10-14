import { canEdit } from '../lib/auth.ts';
import { AppError, refuse } from '../lib/errors.ts';
import { optionalString, requireString } from '../lib/http.ts';
import { LIMITS, isItemId, sanitiseOps, type Item } from './items.ts';
import { isTemplateId, templateItems } from './templates.ts';
import { MAP_STATUSES, type MapPatch, type MapPreview, type MapRecord, type MapStatus, type Store, type UserRecord } from '../store/types.ts';

/**
 * Maps: listing, creating, and keeping everybody's copy of a board in step.
 *
 * Collaboration is deliberately simple. Each browser sends its changes as a
 * batch of item puts and deletes and asks for everything that changed since
 * the last revision it saw, in the same request. The server applies the batch
 * under the board lock, so the last write to an item wins and every browser
 * converges on the same board. Two people editing different things on one
 * board never collide; two people editing the same sticky at the same moment
 * get the later edit, which is what Miro does too.
 */

/** How long a browser counts as "on the board" after its last sync. */
export const PRESENCE_WINDOW_MS = 30_000;
const MAX_SELECTION = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireMapId(value: string | null): string {
  // A malformed id is simply a map that does not exist; it must never reach
  // Postgres as a uuid cast, where it would be a 500 rather than a 404.
  if (!value || !UUID.test(value)) refuse('NOT_FOUND');
  return value.toLowerCase();
}

export function publicMap(map: MapRecord) {
  return {
    mapId: map.mapId,
    name: map.name,
    area: map.area,
    description: map.description,
    status: map.status,
    revision: map.revision,
    itemCount: map.itemCount,
    preview: map.preview,
    createdByName: map.createdByName,
    updatedByName: map.updatedByName,
    createdAt: map.createdAt,
    updatedAt: map.updatedAt,
    archivedAt: map.archivedAt,
  };
}

async function requireMap(store: Store, mapId: string): Promise<MapRecord> {
  const map = await store.maps.get(mapId);
  if (!map) refuse('NOT_FOUND');
  return map;
}

function readStatus(value: unknown): MapStatus | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(MAP_STATUSES as readonly string[]).includes(value)) refuse('INVALID_REQUEST', { field: 'status' });
  return value as MapStatus;
}

export async function listMaps(store: Store, archived: boolean) {
  return (await store.maps.list({ archived })).map(publicMap);
}

export async function createMap(store: Store, user: UserRecord, body: Record<string, unknown>) {
  if (!canEdit(user)) throw new AppError('READ_ONLY');
  const name = requireString(body.name, 'name', 120);
  const area = optionalString(body.area, 'area', 60) ?? '';
  const description = optionalString(body.description, 'description', 1000) ?? '';
  const template = body.template === undefined ? 'blank' : body.template;
  if (!isTemplateId(template)) refuse('INVALID_REQUEST', { field: 'template' });
  const map = await store.maps.create({ name, area, description, userId: user.userId, items: templateItems(template) });
  return publicMap(map);
}

export async function duplicateMap(store: Store, user: UserRecord, mapId: string) {
  if (!canEdit(user)) throw new AppError('READ_ONLY');
  const source = await requireMap(store, mapId);
  const items = (await store.maps.items(mapId, 0)).flatMap((row) => (row.item ? [row.item] : []));
  const map = await store.maps.create({
    name: `Copy of ${source.name}`.slice(0, 120),
    area: source.area,
    description: source.description,
    userId: user.userId,
    items,
  });
  if (source.preview) await store.maps.setPreview(map.mapId, source.preview);
  return publicMap({ ...map, preview: source.preview });
}

export async function updateMap(store: Store, user: UserRecord, mapId: string, body: Record<string, unknown>) {
  if (!canEdit(user)) throw new AppError('READ_ONLY');
  await requireMap(store, mapId);
  const patch: MapPatch = {};
  if (body.name !== undefined) patch.name = requireString(body.name, 'name', 120);
  if (body.area !== undefined) patch.area = optionalString(body.area, 'area', 60) ?? '';
  if (body.description !== undefined) patch.description = optionalString(body.description, 'description', 1000) ?? '';
  const status = readStatus(body.status);
  if (status) patch.status = status;
  if (body.archived !== undefined) {
    if (typeof body.archived !== 'boolean') refuse('INVALID_REQUEST', { field: 'archived' });
    patch.archived = body.archived;
  }
  if (!Object.keys(patch).length) refuse('INVALID_REQUEST');
  const map = await store.maps.update(mapId, patch, user.userId);
  if (!map) refuse('NOT_FOUND');
  return publicMap(map);
}

export async function loadMap(store: Store, user: UserRecord, mapId: string) {
  const map = await requireMap(store, mapId);
  const rows = await store.maps.items(mapId, 0);
  const items = rows.flatMap((row) => (row.item ? [row.item] : []));
  const revision = Math.max(map.revision, ...rows.map((row) => row.revision));
  return { map: publicMap(map), items, revision, canEdit: canEdit(user) && !map.archivedAt };
}

const PREVIEW_KINDS = new Set(['s', 'p', 'd', 't', 'x', 'l']);
const PREVIEW_MAX = 400;

/**
 * The browser draws the thumbnail; the server only checks it is numbers in
 * range. Anything malformed is dropped rather than refused, because a bad
 * thumbnail must never cost somebody their edits.
 */
export function readPreview(value: unknown): MapPreview | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const n = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= -10 && x <= 1010;
  if (!n(v.w) || !n(v.h) || !Array.isArray(v.shapes) || !Array.isArray(v.links)) return null;
  const shapes = v.shapes.slice(0, PREVIEW_MAX).filter(
    (s): s is [string, number, number, number, number, string] =>
      Array.isArray(s) && s.length === 6 && PREVIEW_KINDS.has(s[0]) && n(s[1]) && n(s[2]) && n(s[3]) && n(s[4]) &&
      typeof s[5] === 'string' && /^#[0-9a-f]{6}$/i.test(s[5]),
  );
  const links = v.links.slice(0, PREVIEW_MAX).filter(
    (l): l is [number, number, number, number] => Array.isArray(l) && l.length === 4 && l.every(n),
  );
  const round = (x: number) => Math.round(x);
  return {
    w: round(v.w as number),
    h: round(v.h as number),
    shapes: shapes.map(([k, x, y, w, h, c]) => [k, round(x), round(y), round(w), round(h), c.toLowerCase()]),
    links: links.map((l) => l.map(round) as [number, number, number, number]),
  };
}

function readSelection(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isItemId).slice(0, MAX_SELECTION);
}

/**
 * One round trip: push this browser's changes, report what it has selected,
 * and pull everything that changed since it last looked.
 */
export async function syncMap(store: Store, user: UserRecord, mapId: string, body: Record<string, unknown>) {
  const since = body.since;
  if (typeof since !== 'number' || !Number.isInteger(since) || since < 0) refuse('INVALID_REQUEST', { field: 'since' });
  const ops = sanitiseOps(body.ops);

  let map = await requireMap(store, mapId);
  if (ops.length) {
    if (!canEdit(user)) throw new AppError('READ_ONLY');
    const result = await store.maps.apply(mapId, ops, user.userId, LIMITS.itemsPerMap);
    if (!result.ok) refuse(result.code);
  }
  // Sent after edits, or on opening a map that has no thumbnail yet.
  const preview = canEdit(user) && !map.archivedAt ? readPreview(body.preview) : null;
  if (preview) await store.maps.setPreview(mapId, preview);
  if (ops.length || preview) map = await requireMap(store, mapId);

  const clientId = isItemId(body.client) ? body.client : '';
  await store.maps.touchPresence(mapId, user.userId, clientId, readSelection(body.selection));

  // A browser ahead of the server means the server's history was reset under
  // it (a restored database, a re-created map). Send the whole board again.
  const reset = since > map.revision;
  const rows = await store.maps.items(mapId, reset ? 0 : since);
  const revision = Math.max(map.revision, ...rows.map((row) => row.revision));
  const presence = (await store.maps.presence(mapId, PRESENCE_WINDOW_MS))
    .filter((p) => p.userId !== user.userId)
    .map((p) => ({ userId: p.userId, clientId: p.clientId, name: p.name, selection: p.selection }));

  return {
    revision,
    reset,
    items: rows.map((row) => ({ id: row.id, item: row.item as Item | null, deleted: row.deleted })),
    presence,
    map: publicMap(map),
    canEdit: canEdit(user) && !map.archivedAt,
  };
}
