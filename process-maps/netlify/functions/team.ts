import { getStore } from '../../src/domain/context.ts';
import { addTeamMember, listTeam, updateTeamMember } from '../../src/domain/team.ts';
import { requireAdmin } from '../../src/lib/auth.ts';
import { refuse } from '../../src/lib/errors.ts';
import { handler, json, pathSegment, readJson, requireMethod } from '../../src/lib/http.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET   /api/team        everybody, admins only
 * POST  /api/team        { email, name, role }  add somebody; returns their first password once
 *                        { agent: true, name, role }  add an agent; returns its access key once
 * PATCH /api/team/:id    { name?, role?, active?, resetPassword?, newKey? }
 *
 * Standalone only; inside Peggy, Peggy's user management takes over.
 */
export default handler(async (request) => {
  const store = await getStore();
  const admin = await requireAdmin(request, store);
  const userId = pathSegment(request, '/api/team/');

  if (!userId) {
    requireMethod(request, 'GET', 'POST');
    if (request.method === 'GET') return json({ ok: true, team: await listTeam(store) });
    const result = await addTeamMember(store, await readJson(request));
    return json({ ok: true, ...result }, 201);
  }

  requireMethod(request, 'PATCH');
  if (!UUID.test(userId)) refuse('NOT_FOUND', null, 'That person could not be found.');
  const result = await updateTeamMember(store, admin, userId.toLowerCase(), await readJson(request));
  return json({ ok: true, ...result });
});

export const config = { path: ['/api/team', '/api/team/:id'] };
