import { getStore } from '../../src/domain/context.ts';
import { agentGuide } from '../../src/domain/agent-guide.ts';
import { createMapForAgent, editMapForAgent, listMapsForAgent, readMapForAgent } from '../../src/domain/agent.ts';
import { requireMapId } from '../../src/domain/maps.ts';
import { requireAgent } from '../../src/lib/auth.ts';
import { handler, json, pathSegment, readAgentJson, requireMethod } from '../../src/lib/http.ts';

/**
 * The API for agents: maps as words, edits as plain commands.
 *
 * GET  /llms.txt, /api/agent         the guide (no key needed)
 * GET  /api/agent/maps               the maps (?archived=1 for the archive)
 * POST /api/agent/maps               { name, area?, description?, template? }
 * GET  /api/agent/maps/:id           the map as JSON plus a readable outline (?format=text for the outline alone)
 * POST /api/agent/maps/:id           { changes: [...] }, see src/domain/agent.ts
 *
 * Key only: an access key in "Authorization: Bearer", or ?key= for agents
 * that cannot set headers. A cookie is never accepted here.
 */
export default handler(
  async (request) => {
    const url = new URL(request.url);
    const origin = url.origin;

    if (url.pathname === '/llms.txt' || url.pathname === '/api/agent') {
      requireMethod(request, 'GET', 'HEAD');
      return new Response(agentGuide(origin), {
        headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'public, max-age=300' },
      });
    }

    const store = await getStore();
    const agent = await requireAgent(request, store);
    const rawId = pathSegment(request, '/api/agent/maps/');

    if (!rawId) {
      requireMethod(request, 'GET', 'POST');
      if (request.method === 'GET') {
        return json({ ok: true, maps: await listMapsForAgent(store, origin, url.searchParams.get('archived') === '1') });
      }
      return json({ ok: true, ...(await createMapForAgent(store, agent, await readAgentJson(request), origin)) }, 201);
    }

    const mapId = requireMapId(rawId);
    requireMethod(request, 'GET', 'POST');
    if (request.method === 'GET') {
      const view = await readMapForAgent(store, agent, mapId, origin);
      if (url.searchParams.get('format') === 'text') {
        return new Response(view.text, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
      }
      return json({ ok: true, ...view });
    }
    return json({ ok: true, ...(await editMapForAgent(store, agent, mapId, await readAgentJson(request), origin)) });
  },
  { keyOnly: true },
);

export const config = { path: ['/llms.txt', '/api/agent', '/api/agent/maps', '/api/agent/maps/:id'] };
