/**
 * Agents: an admin adds one on the Team page and gets its key once; the agent
 * finds its way in from a fetched page, reads and edits a map through the API
 * and MCP, and somebody with the board open sees the edit arrive with the
 * agent's name on it. A new key retires the old one; deactivating stops it.
 */
export default async function run({ browser, base, out, check, watch }) {
  const A = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  watch(A);
  await A.goto(`${base}/maps/`);
  await A.fill('input[name=email]', 'admin@example.com');
  await A.fill('input[name=password]', 'local-admin-password');
  await A.click('button[type=submit]');
  await A.waitForSelector('.pm-page__head h1');

  // What an agent sees when it fetches a page without running it.
  const raw = await (await fetch(`${base}/maps/board.html?id=x`)).text();
  check('a fetched board page points agents at the guide', raw.includes('/llms.txt') && raw.includes('<noscript>'));
  const guide = await fetch(`${base}/llms.txt`);
  const guideText = await guide.text();
  check('the guide is served without a key', guide.ok && guideText.includes('/api/mcp') && guideText.includes('"action":"add"'));

  // The admin adds Crocbot and gets its key once.
  await A.goto(`${base}/maps/team.html`);
  await A.click('.pm-page__actions button:has-text("Add agent")');
  await A.fill('input[name=name]', 'Crocbot');
  await A.click('dialog button[type=submit]');
  await A.waitForSelector('.pm-secret code');
  const key = (await A.textContent('.pm-secret code')).trim();
  check('the key is shown once, after adding the agent', key.startsWith('pmk_'));
  await A.screenshot({ path: `${out}/16-agent-key.png` });
  await A.click('button:has-text("Done")');
  await A.waitForTimeout(300);
  check('the team list marks Crocbot as an agent', (await A.locator('tr:has-text("Crocbot") .pm-tag', { hasText: 'Agent' }).count()) === 1);
  check('an agent gets "New key", not "Reset password"',
    (await A.locator('tr:has-text("Crocbot") button:has-text("New key")').count()) === 1 &&
    (await A.locator('tr:has-text("Crocbot") button:has-text("Reset password")').count()) === 0);
  await A.screenshot({ path: `${out}/17-team-agents.png` });

  const call = (path, body, k = key) => fetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const mcp = async (method, params, k = key) => {
    const response = await call('/api/mcp', { jsonrpc: '2.0', id: 1, method, params }, k);
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  // The agent makes a map with the HTTP API.
  const made = await (await call('/api/agent/maps', { name: 'Plant hire request', area: 'Projects' })).json();
  const mapId = made.map?.mapId;
  check('the agent makes a map', Boolean(mapId));
  await call(`/api/agent/maps/${mapId}`, {
    changes: [
      { action: 'add', kind: 'start', lane: 'Site supervisor', id: 'start' },
      { action: 'add', kind: 'step', text: 'Request plant in the app', lane: 'Site supervisor', after: 'start', system: 'Assignar' },
    ],
  });

  // The admin opens it; the agent keeps going over MCP while they watch.
  await A.goto(`${base}/maps/board.html?id=${mapId}`);
  await A.waitForSelector('.pm-node--step');
  const init = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  check('MCP initialize answers with the tools capability', init.body?.result?.capabilities?.tools !== undefined);
  const tools = await mcp('tools/list', {});
  check('MCP lists the four tools', tools.body?.result?.tools?.map((t) => t.name).join() === 'list_maps,read_map,create_map,edit_map');
  const edit = await mcp('tools/call', {
    name: 'edit_map',
    arguments: {
      map: 'Plant hire request',
      changes: [
        { action: 'add', kind: 'decision', text: 'Under $5k?', lane: 'Project manager', after: 'Request plant in the app' },
        { action: 'add', kind: 'step', text: 'Book with the supplier', lane: 'Project manager', after: 'Under $5k?', label: 'Yes' },
        { action: 'add', kind: 'note', text: 'Who books it over $5k?', near: 'Under $5k?', flag: 'question' },
      ],
    },
  });
  check('MCP edit_map applies the changes', edit.body?.result && !edit.body.result.isError, edit.body?.result?.content?.[0]?.text?.split('\n')[0]);
  const started = Date.now();
  await A.waitForSelector('.pm-node:has-text("Book with the supplier")', { timeout: 8000 });
  check('the agent\'s edit appears on the open board', true, `${Date.now() - started} ms`);
  await A.waitForSelector('.pm-people .pm-avatar[title*="Crocbot"]', { timeout: 6000 }).catch(() => {});
  check('people on the board see the agent', (await A.locator('.pm-people .pm-avatar[title*="Crocbot"]').count()) === 1);
  check('what the agent changed is outlined with its name', (await A.locator('.pm-sel__tag', { hasText: 'Crocbot' }).count()) >= 1);
  await A.screenshot({ path: `${out}/18-agent-edit.png` });

  const read = await mcp('tools/call', { name: 'read_map', arguments: { map: mapId } });
  const outline = read.body?.result?.content?.[0]?.text ?? '';
  check('read_map shows the flow in words', outline.includes('Lane "Project manager"') && outline.includes('-> ') && outline.includes('(Yes)'));
  const bad = await mcp('tools/call', { name: 'edit_map', arguments: { map: mapId, changes: [{ action: 'connect', from: 'No such step', to: 'Under $5k?' }] } });
  check('a bad change comes back as a message the agent can act on', bad.body?.result?.isError === true && /No such step/.test(bad.body.result.content[0].text));

  // A new key retires the old one.
  await A.goto(`${base}/maps/team.html`);
  await A.click('tr:has-text("Crocbot") button:has-text("New key")');
  await A.click('dialog button:has-text("Make new key")');
  await A.waitForSelector('.pm-secret code');
  const second = (await A.textContent('.pm-secret code')).trim();
  await A.click('button:has-text("Done")');
  check('the old key stops working after a new one is made', (await call('/api/agent/maps')).status === 401);
  check('the new key works', (await call('/api/agent/maps', null, second)).status === 200);

  // Deactivating the agent stops its key.
  await A.waitForTimeout(300);
  await A.click('tr:has-text("Crocbot") button:has-text("Deactivate")');
  await A.click('dialog button:has-text("Deactivate")');
  await A.waitForTimeout(300);
  check('a deactivated agent is refused', (await mcp('tools/list', {}, second)).status === 401);
}
