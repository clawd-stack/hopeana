import { getStore } from '../../src/domain/context.ts';
import { createMap, duplicateMap, listMaps, loadMap, requireMapId, updateMap } from '../../src/domain/maps.ts';
import { requireUser } from '../../src/lib/auth.ts';
import { handler, json, readJson, requireMethod } from '../../src/lib/http.ts';

/**
 * GET   /api/maps                  the team's maps (?archived=1 for the archive)
 * POST  /api/maps                  { name, area?, description?, template? }
 * GET   /api/maps/:id              a map and everything on it
 * PATCH /api/maps/:id              { name?, area?, description?, status?, archived? }
 * POST  /api/maps/:id/duplicate    a copy of a map
 *
 * Edits to what is on a map go through /api/maps/:id/sync.
 */
export default handler(async (request) => {
  const store = await getStore();
  const user = await requireUser(request, store);
  const url = new URL(request.url);
  const [, , , rawId, action] = url.pathname.split('/');

  if (!rawId) {
    requireMethod(request, 'GET', 'POST');
    if (request.method === 'GET') {
      return json({ ok: true, maps: await listMaps(store, url.searchParams.get('archived') === '1') });
    }
    return json({ ok: true, map: await createMap(store, user, await readJson(request)) }, 201);
  }

  const mapId = requireMapId(rawId);
  if (action === 'duplicate') {
    requireMethod(request, 'POST');
    return json({ ok: true, map: await duplicateMap(store, user, mapId) }, 201);
  }

  requireMethod(request, 'GET', 'PATCH');
  if (request.method === 'GET') return json({ ok: true, ...(await loadMap(store, user, mapId)) });
  return json({ ok: true, map: await updateMap(store, user, mapId, await readJson(request)) });
});

export const config = { path: ['/api/maps', '/api/maps/:id', '/api/maps/:id/duplicate'] };
