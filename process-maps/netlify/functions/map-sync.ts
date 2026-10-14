import { getStore } from '../../src/domain/context.ts';
import { requireMapId, syncMap } from '../../src/domain/maps.ts';
import { requireUser } from '../../src/lib/auth.ts';
import { handler, json, pathSegment, readJson, requireMethod } from '../../src/lib/http.ts';

/**
 * POST /api/maps/:id/sync  { since, ops?, selection? }
 *
 * The board's one hot path: every open browser calls this every few seconds.
 * It pushes that browser's edits, records who is looking at what, and returns
 * everything that changed since revision `since`.
 */
export default handler(async (request) => {
  requireMethod(request, 'POST');
  const store = await getStore();
  const user = await requireUser(request, store);
  const mapId = requireMapId(pathSegment(request, '/api/maps/'));
  return json({ ok: true, ...(await syncMap(store, user, mapId, await readJson(request))) });
});

export const config = { path: '/api/maps/:id/sync' };
