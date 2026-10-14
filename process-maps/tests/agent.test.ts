import { beforeEach, describe, expect, it } from 'vitest';
import { overrideStore } from '../src/domain/context.ts';
import { createMemoryStore, type MemoryStore } from '../src/store/memory.ts';
import type { NodeItem } from '../src/domain/items.ts';
import { BASE, cookieFor, get, makeUser, send } from './helpers.ts';

import teamHandler from '../netlify/functions/team.ts';
import mapsHandler from '../netlify/functions/maps.ts';
import syncHandler from '../netlify/functions/map-sync.ts';
import passwordHandler from '../netlify/functions/auth-password.ts';
import agentHandler from '../netlify/functions/agent.ts';
import mcpHandler from '../netlify/functions/mcp.ts';

/**
 * Agents: keys, what a key can and cannot reach, the plain-command edits and
 * where they put things, and the MCP endpoint. The board itself is covered
 * by the browser tests (tests/browser/agents.mjs).
 */

let store: MemoryStore;
let adminCookie: string;
beforeEach(async () => {
  store = createMemoryStore();
  overrideStore(store);
  adminCookie = cookieFor(await makeUser(store, 'admin'));
});

const body = async (response: Response) => response.json() as Promise<Record<string, any>>;

async function addAgent(role = 'editor', name = 'Crocbot') {
  const response = await teamHandler(send('POST', '/api/team', { agent: true, name, role }, adminCookie));
  expect(response.status).toBe(201);
  const result = await body(response);
  return { user: result.user, key: result.apiKey as string };
}

function agent(method: string, path: string, key: string | null, payload?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
    body: payload === undefined ? undefined : typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

async function newMap(key: string, name = 'Supplier invoices') {
  const response = await agentHandler(agent('POST', '/api/agent/maps', key, { name }));
  expect(response.status).toBe(201);
  return (await body(response)).map.mapId as string;
}

async function edit(key: string, mapId: string, changes: unknown[]): Promise<Record<string, any>> {
  const response = await agentHandler(agent('POST', `/api/agent/maps/${mapId}`, key, { changes }));
  return { status: response.status, ...(await body(response)) };
}

async function nodes(mapId: string): Promise<NodeItem[]> {
  return (await store.maps.items(mapId, 0)).flatMap((r) => (r.item && r.item.kind !== 'connector' ? [r.item as NodeItem] : []));
}

describe('agent members', () => {
  it('adds an agent with a key shown once, no email and no password', async () => {
    const { user, key } = await addAgent();
    expect(key).toMatch(/^pmk_[A-Za-z0-9_-]{40,}$/);
    expect(user).toMatchObject({ name: 'Crocbot', isAgent: true, email: null, role: 'editor' });
    expect(user.apiKeyCreatedAt).toBeTruthy();
    const team = await body(await teamHandler(get('/api/team', adminCookie)));
    expect(JSON.stringify(team)).not.toContain(key);
  });

  it('never makes an agent an admin', async () => {
    const response = await teamHandler(send('POST', '/api/team', { agent: true, name: 'Boss bot', role: 'admin' }, adminCookie));
    expect(response.status).toBe(400);
    const { user } = await addAgent();
    expect((await teamHandler(send('PATCH', `/api/team/${user.userId}`, { role: 'admin' }, adminCookie))).status).toBe(400);
  });

  it('gives agents new keys, and people passwords, and not the other way round', async () => {
    const { user, key } = await addAgent();
    expect((await teamHandler(send('PATCH', `/api/team/${user.userId}`, { resetPassword: true }, adminCookie))).status).toBe(400);
    const fresh = await body(await teamHandler(send('PATCH', `/api/team/${user.userId}`, { newKey: true }, adminCookie)));
    expect(fresh.apiKey).toMatch(/^pmk_/);
    expect((await agentHandler(agent('GET', '/api/agent/maps', key))).status).toBe(401);
    expect((await agentHandler(agent('GET', '/api/agent/maps', fresh.apiKey))).status).toBe(200);
    const person = await makeUser(store, 'editor');
    expect((await teamHandler(send('PATCH', `/api/team/${person.userId}`, { newKey: true }, adminCookie))).status).toBe(400);
  });

  it('stops a deactivated agent at once', async () => {
    const { user, key } = await addAgent();
    await teamHandler(send('PATCH', `/api/team/${user.userId}`, { active: false }, adminCookie));
    expect((await agentHandler(agent('GET', '/api/agent/maps', key))).status).toBe(401);
  });
});

describe('what a key reaches', () => {
  it('works on the ordinary maps API too, as the agent', async () => {
    const { key } = await addAgent();
    const created = await mapsHandler(agent('POST', '/api/maps', key, { name: 'Made over the API' }, { 'content-type': 'application/json' }));
    expect(created.status).toBe(201);
    expect((await body(created)).map.createdByName).toBe('Crocbot');
  });

  it('is not slowed by the same-site check, which only guards cookies', async () => {
    const { key } = await addAgent();
    const response = await mapsHandler(agent('POST', '/api/maps', key, { name: 'Cross-site with a key' }, {
      'content-type': 'application/json', origin: 'https://elsewhere.example', 'sec-fetch-site': 'cross-site',
    }));
    expect(response.status).toBe(201);
  });

  it('never falls back to a cookie when the key is wrong', async () => {
    const response = await mapsHandler(new Request(`${BASE}/api/maps`, { headers: { authorization: 'Bearer pmk_wrong', cookie: adminCookie } }));
    expect(response.status).toBe(401);
  });

  it('leaves Basic auth (a password-protected deploy) to the cookie', async () => {
    const response = await mapsHandler(new Request(`${BASE}/api/maps`, { headers: { authorization: 'Basic dXNlcjpwYXNz', cookie: adminCookie } }));
    expect(response.status).toBe(200);
    const forged = await mapsHandler(new Request(`${BASE}/api/maps`, {
      method: 'POST',
      headers: { authorization: 'Basic dXNlcjpwYXNz', cookie: adminCookie, 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ name: 'forged' }),
    }));
    expect(forged.status).toBe(403);
  });

  it('cannot manage the team or change a password', async () => {
    const { key } = await addAgent();
    expect((await teamHandler(agent('GET', '/api/team', key))).status).toBe(403);
    const pw = await passwordHandler(agent('POST', '/api/auth/password', key, { current: 'x'.repeat(12), next: 'y'.repeat(12) }, { 'content-type': 'application/json' }));
    expect(pw.status).toBe(403);
  });

  it('takes ?key= on the agent API and MCP only, and never a cookie there', async () => {
    const { key } = await addAgent();
    expect((await agentHandler(new Request(`${BASE}/api/agent/maps?key=${key}`))).status).toBe(200);
    expect((await mapsHandler(new Request(`${BASE}/api/maps?key=${key}`))).status).toBe(401);
    expect((await agentHandler(get('/api/agent/maps', adminCookie))).status).toBe(401);
  });

  it('lets a viewer agent read but not change', async () => {
    const editor = await addAgent();
    const viewer = await addAgent('viewer', 'Readbot');
    const mapId = await newMap(editor.key);
    expect((await agentHandler(agent('GET', `/api/agent/maps/${mapId}`, viewer.key))).status).toBe(200);
    const refused = await edit(viewer.key, mapId, [{ action: 'add', kind: 'step', text: 'Nope' }]);
    expect(refused.status).toBe(403);
  });
});

describe('the guide', () => {
  it('is served without a key, with this site\'s own addresses in it', async () => {
    for (const path of ['/llms.txt', '/api/agent']) {
      const response = await agentHandler(new Request(`${BASE}${path}`));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/markdown');
      const text = await response.text();
      expect(text).toContain(`${BASE}/api/mcp`);
      expect(text).toContain('Authorization: Bearer pmk_');
    }
  });
});

describe('editing with plain commands', () => {
  it('builds a flow in lanes, laid out left to right without overlaps', async () => {
    const { key } = await addAgent();
    const mapId = await newMap(key);
    const result = await edit(key, mapId, [
      { action: 'add', kind: 'start', lane: 'Supplier', id: 'start' },
      { action: 'add', kind: 'step', text: 'Invoice arrives', lane: 'Supplier', after: 'start' },
      { action: 'add', kind: 'step', text: 'Match to PO', lane: 'AP clerk', after: 'Invoice arrives', owner: 'AP clerk', system: 'Xero', duration: '10 min', flag: 'pain point' },
      { action: 'add', kind: 'decision', text: 'Matches?', lane: 'AP clerk', after: 'Match to PO' },
      { action: 'add', kind: 'step', text: 'Pay', lane: 'Finance', after: 'Matches?', label: 'Yes' },
      { action: 'add', kind: 'note', text: 'Over $50k?', near: 'Pay', flag: 'question' },
    ]);
    expect(result.status).toBe(200);
    expect(result.created).toHaveLength(9); // 3 lanes made on the way, 6 shapes
    expect(result.notes.join(' ')).toContain('Made a new lane "AP clerk"');

    const all = await nodes(mapId);
    const by = (text: string) => all.find((n) => n.text === text)!;
    const lanes = all.filter((n) => n.kind === 'lane').sort((a, b) => a.y - b.y);
    expect(lanes.map((l) => l.text)).toEqual(['Supplier', 'AP clerk', 'Finance']);
    const inLane = (n: NodeItem, lane: NodeItem) => n.y >= lane.y && n.y + n.h <= lane.y + lane.h;
    expect(inLane(by('Match to PO'), lanes[1]!)).toBe(true);
    expect(by('Match to PO').x).toBeGreaterThan(by('Invoice arrives').x + by('Invoice arrives').w);
    expect(by('Pay').x).toBeGreaterThan(by('Matches?').x);
    expect(by('Match to PO')).toMatchObject({ owner: 'AP clerk', system: 'Xero', duration: '10 min', flag: 'pain' });
    // Every lane reaches past the furthest shape.
    const right = Math.max(...all.filter((n) => n.kind !== 'lane').map((n) => n.x + n.w));
    for (const lane of lanes) expect(lane.x + lane.w).toBeGreaterThan(right);
    // Nothing sits on top of anything else.
    const shapes = all.filter((n) => n.kind !== 'lane');
    for (const a of shapes) for (const b of shapes) {
      if (a === b) continue;
      const clash = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      expect(clash, `${a.text} overlaps ${b.text}`).toBe(false);
    }

    const outline = await (await agentHandler(agent('GET', `/api/agent/maps/${mapId}?format=text`, key))).text();
    expect(outline).toContain('Lane "AP clerk"');
    expect(outline).toMatch(/Decision: "Matches\?"\n {4}-> \[[^\]]+\] "Pay" \(Yes\)/);
    expect(outline).toContain('flag: pain');
  });

  it('updates, moves, connects, disconnects and deletes by id or by text', async () => {
    const { key } = await addAgent();
    const mapId = await newMap(key);
    await edit(key, mapId, [
      { action: 'add', kind: 'step', text: 'One', id: 'one' },
      { action: 'add', kind: 'step', text: 'Two', after: 'one' },
      { action: 'add', kind: 'step', text: 'Three', id: 'three' },
    ]);
    const result = await edit(key, mapId, [
      { action: 'update', item: 'Two', text: 'Second', notes: 'Checked twice', color: 'blue', flag: 'idea' },
      { action: 'connect', from: 'Second', to: 'three', label: 'then' },
      { action: 'disconnect', from: 'one', to: 'Second' },
      { action: 'move', item: 'one', lane: 'Office' },
      { action: 'set_map', status: 'in review', description: 'By the bot' },
    ]);
    expect(result.status).toBe(200);
    const view = await body(await agentHandler(agent('GET', `/api/agent/maps/${mapId}`, key)));
    expect(view.map).toMatchObject({ status: 'in_review', description: 'By the bot' });
    const second = view.items.find((i: any) => i.text === 'Second');
    expect(second).toMatchObject({ notes: 'Checked twice', color: '#e7f1fb', flag: 'idea' });
    expect(second.next).toEqual([expect.objectContaining({ id: 'three', label: 'then' })]);
    expect(view.connectors.some((c: any) => c.from === 'one')).toBe(false);
    expect(view.items.find((i: any) => i.id === 'one').lane).toBe(view.lanes[0].id);

    await edit(key, mapId, [{ action: 'delete', item: 'Second' }]);
    const after = await body(await agentHandler(agent('GET', `/api/agent/maps/${mapId}`, key)));
    expect(after.items.map((i: any) => i.text)).not.toContain('Second');
    expect(after.connectors).toHaveLength(0); // its arrows went with it
  });

  it('refuses the whole batch when one change is wrong, and says which', async () => {
    const { key } = await addAgent();
    const mapId = await newMap(key);
    const result = await edit(key, mapId, [
      { action: 'add', kind: 'step', text: 'Fine' },
      { action: 'connect', from: 'Fine', to: 'Missing step' },
    ]);
    expect(result.status).toBe(400);
    expect(result.message).toMatch(/^Change 2 \(connect\): nothing on the map is "Missing step"/);
    expect(await nodes(mapId)).toHaveLength(0);
  });

  it('asks for an id when text matches more than one thing', async () => {
    const { key } = await addAgent();
    const mapId = await newMap(key);
    await edit(key, mapId, [{ action: 'add', kind: 'step', text: 'Check' }, { action: 'add', kind: 'step', text: 'Check' }]);
    const result = await edit(key, mapId, [{ action: 'update', item: 'check', notes: 'which?' }]);
    expect(result.status).toBe(400);
    expect(result.message).toContain('matches 2 items');
  });

  it('explains unknown actions, kinds, flags and colours', async () => {
    const { key } = await addAgent();
    const mapId = await newMap(key);
    for (const [change, words] of [
      [{ action: 'paint' }, 'unknown action'],
      [{ action: 'add', kind: 'cloud', text: 'x' }, 'unknown kind'],
      [{ action: 'add', kind: 'step', text: 'x', flag: 'urgent' }, 'unknown flag'],
      [{ action: 'add', kind: 'step', text: 'x', color: 'plaid' }, 'unknown colour'],
      [{ action: 'add', kind: 'step' }, '"text" is missing'],
    ] as const) {
      const result = await edit(key, mapId, [change]);
      expect(result.status, JSON.stringify(change)).toBe(400);
      expect(result.message).toContain(words);
    }
  });

  it('cleans what it is sent, like any other edit', async () => {
    const { key } = await addAgent();
    const mapId = await newMap(key);
    const result = await edit(key, mapId, [{ action: 'add', kind: 'step', text: `bad\u0000text\ud800 ${'x'.repeat(5000)}` }]);
    expect(result.status).toBe(200);
    const [step] = await nodes(mapId);
    expect(step!.text).not.toContain('\u0000');
    expect(step!.text.length).toBeLessThanOrEqual(4000);
  });

  it('leaves archived maps alone', async () => {
    const { key } = await addAgent();
    const mapId = await newMap(key);
    await mapsHandler(send('PATCH', `/api/maps/${mapId}`, { archived: true }, adminCookie));
    expect((await edit(key, mapId, [{ action: 'add', kind: 'step', text: 'x' }])).status).toBe(409);
  });

  it('keeps the thumbnail current and shows people who did it', async () => {
    const { key } = await addAgent();
    const mapId = await newMap(key);
    await edit(key, mapId, [{ action: 'add', kind: 'step', text: 'Visible', id: 'v' }]);
    expect((await store.maps.get(mapId))!.preview!.shapes).toHaveLength(1);
    // Somebody with the board open sees the agent, with what it touched selected.
    const person = await makeUser(store, 'editor');
    const sync = await body(await syncHandler(send('POST', `/api/maps/${mapId}/sync`, { since: 0 }, cookieFor(person))));
    expect(sync.presence).toEqual([expect.objectContaining({ name: 'Crocbot', selection: ['v'] })]);
    expect(sync.items.map((i: any) => i.id)).toContain('v');
  });
});

describe('MCP', () => {
  const rpc = (key: string | null, message: unknown) =>
    mcpHandler(agent('POST', '/api/mcp', key, message, { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }));

  it('initialises, lists tools and answers notifications with 202', async () => {
    const { key } = await addAgent();
    const init = await body(await rpc(key, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }));
    expect(init.result).toMatchObject({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'process-maps' } });
    expect((await rpc(key, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    const list = await body(await rpc(key, { jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    expect(list.result.tools.map((t: any) => t.name)).toEqual(['list_maps', 'read_map', 'create_map', 'edit_map']);
    for (const tool of list.result.tools) expect(tool.inputSchema.type).toBe('object');
  });

  it('runs the tools, finding maps by name', async () => {
    const { key } = await addAgent();
    const call = async (name: string, args: unknown) => (await body(await rpc(key, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }))).result;
    const made = await call('create_map', { name: 'Timesheet approval', template: 'swimlane' });
    expect(made.content[0].text).toContain('Made the map');
    const listed = await call('list_maps', {});
    expect(listed.content[0].text).toContain('"Timesheet approval"');
    expect(listed.structuredContent.maps).toHaveLength(1);
    const edited = await call('edit_map', { map: 'timesheet', changes: [{ action: 'add', kind: 'step', text: 'Approve in Assignar', lane: 'Office', after: 'Check details' }] });
    expect(edited.isError).toBeUndefined();
    expect(edited.content[0].text).toMatch(/^Applied 1 change/);
    const read = await call('read_map', { map: 'Timesheet approval' });
    expect(read.content[0].text).toContain('"Approve in Assignar"');
    const json = await call('read_map', { map: 'Timesheet approval', format: 'json' });
    expect(json.structuredContent.lanes.length).toBeGreaterThan(0);
  });

  it('returns refusals as tool errors the model can read', async () => {
    const { key } = await addAgent();
    const result = (await body(await rpc(key, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'read_map', arguments: { map: 'nothing like this' } } }))).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No map is called');
  });

  it('speaks JSON-RPC errors, batches, and only POST', async () => {
    const { key } = await addAgent();
    expect((await body(await rpc(key, { jsonrpc: '2.0', id: 5, method: 'resources/list' }))).error.code).toBe(-32601);
    expect((await body(await rpc(key, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'fly', arguments: {} } }))).error.code).toBe(-32602);
    expect((await body(await rpc(key, '{not json'))).error.code).toBe(-32700);
    const batch = await body(await rpc(key, [{ jsonrpc: '2.0', id: 7, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 8, method: 'ping' }]));
    expect(batch).toHaveLength(2);
    expect((await mcpHandler(agent('GET', '/api/mcp', key))).status).toBe(405);
  });

  it('wants a key', async () => {
    const response = await rpc(null, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
  });
});
