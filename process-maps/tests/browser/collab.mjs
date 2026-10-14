/**
 * Two people on one board at once, plus the team page and a view-only user:
 * presence, live selection, moves, undo, connecting, marquee, duplicate,
 * delete and the PNG export.
 */
export default async function run({ browser, base, out, check, watch }) {
  async function signIn(page, email, password) {
    await page.goto(`${base}/maps/`);
    await page.fill('input[name=email]', email);
    await page.fill('input[name=password]', password);
    await page.click('button[type=submit]');
  }

  // Admin
  const A = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })).newPage();
  watch(A);
  await signIn(A, 'admin@example.com', 'local-admin-password');
  await A.waitForSelector('.pm-page__head h1');

  // Team page: add Sarah (editor) and Viewer Vic.
  await A.goto(`${base}/maps/team.html`);
  await A.click('.pm-page__actions button');
  await A.fill('input[name=name]', 'Sarah Hack');
  await A.fill('input[name=email]', 'sarah@example.com');
  await A.click('dialog button[type=submit]');
  await A.waitForSelector('.pm-secret code');
  const sarahPassword = await A.textContent('.pm-secret code');
  await A.screenshot({ path: `${out}/06-team-password.png` });
  await A.click('button:has-text("Done")');
  await A.click('.pm-page__actions button');
  await A.fill('input[name=name]', 'Vic Viewer');
  await A.fill('input[name=email]', 'vic@example.com');
  await A.selectOption('select[name=role]', 'viewer');
  await A.click('dialog button[type=submit]');
  await A.waitForSelector('.pm-secret code');
  const vicPassword = await A.textContent('.pm-secret code');
  await A.click('button:has-text("Done")');
  await A.waitForTimeout(300);
  await A.screenshot({ path: `${out}/07-team.png` });
  check('team page lists three people', (await A.locator('.pm-table tbody tr').count()) === 3);

  // Open the onboarding map as admin.
  await A.goto(`${base}/maps/`);
  await A.waitForSelector('.pm-mapcard');
  const href = await A.getAttribute('.pm-mapcard:has-text("Employee onboarding")', 'href');
  await A.goto(`${base}${href}`);
  await A.waitForSelector('.pm-node');

  // The admin also has the board open in a second, idle tab. Presence is per
  // tab, so this one must not wipe out what the busy tab has selected.
  const A2 = await A.context().newPage();
  watch(A2);
  await A2.goto(`${base}${href}`);
  await A2.waitForSelector('.pm-node');

  // Sarah signs in (forced password change), opens the same map.
  const S = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  watch(S);
  await signIn(S, 'sarah@example.com', sarahPassword);
  await S.waitForSelector('dialog[open]');
  await S.fill('input[name=current]', sarahPassword);
  await S.fill('input[name=next]', 'sarah-own-password-2026');
  await S.fill('input[name=again]', 'sarah-own-password-2026');
  await S.click('button:has-text("Save password")');
  await S.waitForSelector('.pm-mapcard');
  await S.goto(`${base}${href}`);
  await S.waitForSelector('.pm-node');

  // Presence: each should see the other's avatar within a few seconds.
  await A.waitForSelector('.pm-people .pm-avatar', { timeout: 10000 });
  check('admin sees Sarah on the board', (await A.getAttribute('.pm-people .pm-avatar', 'title')).includes('Sarah'));

  // Sarah adds a sticky; admin should see it.
  await S.mouse.dblclick(900, 700);
  await S.keyboard.type('Sarah was here');
  await S.mouse.click(600, 760);
  await A.waitForFunction(() => window.processMap.model.all().some((i) => i.text === 'Sarah was here'), null, { timeout: 10000 });
  check('admin receives Sarah sticky', true);

  // Admin selects a step; Sarah sees the coloured outline with admin's name.
  await A.locator('.pm-node--step', { hasText: 'Submit request' }).click();
  await S.waitForSelector('.pm-sel--peer .pm-sel__tag', { timeout: 10000 });
  check('Sarah sees admin\'s selection despite the admin\'s idle second tab', (await S.textContent('.pm-sel--peer .pm-sel__tag')).includes('Local Admin'));
  check('the admin shows as one person, not one per tab', (await S.locator('.pm-people .pm-avatar').count()) === 1);
  await S.screenshot({ path: `${out}/08-sarah-sees-admin.png` });

  // The context toolbar stays put while syncs come and go, so a click on it
  // is never lost to a rebuild.
  await A.evaluate(() => {
    window.__toolbar = 0;
    new MutationObserver(() => { window.__toolbar += 1; }).observe(document.querySelector('.pm-context'), { childList: true });
  });
  await A.waitForTimeout(4000);
  check('the toolbar is not rebuilt by background syncs', (await A.evaluate(() => window.__toolbar)) === 0);

  // Admin opens Sarah's sticky to edit but types nothing; meanwhile Sarah
  // changes it. Closing the editor must not write the old text back.
  const stickyBox = await A.locator('.pm-node--sticky', { hasText: 'Sarah was here' }).boundingBox();
  await A.mouse.dblclick(stickyBox.x + stickyBox.width / 2, stickyBox.y + stickyBox.height / 2);
  await A.waitForSelector('.pm-node--sticky [contenteditable]');
  await S.evaluate(() => {
    const m = window.processMap.model;
    const item = m.all().find((i) => i.text === 'Sarah was here');
    m.transact('edit', () => m.put({ ...item, text: 'Sarah edited this' }));
  });
  await A.waitForFunction(() => window.processMap.model.all().some((i) => i.text === 'Sarah edited this'), null, { timeout: 10000 });
  await A.keyboard.press('Escape');
  await A.waitForTimeout(2500);
  const stillSarahs = await S.evaluate(() => window.processMap.model.all().some((i) => i.text === 'Sarah edited this'));
  const adminShows = await A.textContent('.pm-node--sticky:has-text("Sarah")');
  check('opening a note without typing keeps a collaborator\'s edit', stillSarahs && adminShows.includes('Sarah edited this'), adminShows);

  // Admin drags the step; Sarah sees the new position.
  const box = await A.locator('.pm-node--step', { hasText: 'Submit request' }).boundingBox();
  await A.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await A.mouse.down();
  await A.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 20, { steps: 8 });
  const guides = await A.locator('.pm-guide').count();
  await A.mouse.up();
  const moved = await A.evaluate(() => window.processMap.model.all().find((i) => i.text === 'Submit request'));
  await S.waitForFunction((x) => window.processMap.model.all().find((i) => i.text === 'Submit request').x === x, moved.x, { timeout: 10000 });
  check('Sarah receives the move', true, `x=${moved.x}, guides shown while dragging: ${guides}`);

  // Undo on admin moves it back for both.
  await A.keyboard.press('Control+z');
  const back = await A.evaluate(() => window.processMap.model.all().find((i) => i.text === 'Submit request').x);
  await S.waitForFunction((x) => window.processMap.model.all().find((i) => i.text === 'Submit request').x === x, back, { timeout: 10000 });
  check('undo propagates', back !== moved.x, `back to ${back}`);

  // Connect by dragging the + of "Check details" onto "End".
  await A.evaluate(() => {
    window.__mut = [];
    new MutationObserver((list) => { for (const m of list) window.__mut.push(performance.now().toFixed(0) + ' +' + m.addedNodes.length + ' -' + m.removedNodes.length + ' ' + [...m.addedNodes].map((n) => n.className?.baseVal ?? n.className).join(',')); })
      .observe(document.getElementById('overlay'), { childList: true });
  });
  await A.locator('.pm-node--step', { hasText: 'Check details' }).click();
  await A.waitForSelector('.pm-plus[data-side=bottom]');
  await A.waitForTimeout(600);
  check('overlay rebuilt once for the new selection', (await A.evaluate(() => window.__mut.length)) === 1);
  const plus = await A.locator('.pm-plus[data-side=bottom]').boundingBox();
  const endBox = await A.locator('.pm-node--terminal', { hasText: 'End' }).boundingBox();
  const linksBefore = await A.evaluate(() => window.processMap.model.all().filter((i) => i.kind === 'connector').length);
  await A.mouse.move(plus.x + 11, plus.y + 11);
  await A.mouse.down();
  await A.mouse.move(endBox.x + 30, endBox.y + 30, { steps: 10 });
  const dropShown = await A.locator('.pm-drop-target').count();
  await A.mouse.up();
  const linksAfter = await A.evaluate(() => window.processMap.model.all().filter((i) => i.kind === 'connector').length);
  check('drag from + onto a step connects them', linksAfter === linksBefore + 1, `drop target shown: ${dropShown}`);

  // Marquee select the Systems lane contents, copy and paste.
  await A.mouse.click(700, 860);
  await A.mouse.move(980, 590);
  await A.mouse.down();
  await A.mouse.move(1400, 700, { steps: 6 });
  await A.mouse.up();
  const marqueeCount = await A.evaluate(() => window.processMap.ui.selection.size);
  check('marquee selects items', marqueeCount >= 2, `${marqueeCount} selected`);
  const before = await A.evaluate(() => window.processMap.model.size);
  await A.keyboard.press('Control+d');
  const after = await A.evaluate(() => window.processMap.model.size);
  check('duplicate adds copies', after > before, `${before} -> ${after}`);
  await A.keyboard.press('Delete');
  check('delete removes them', (await A.evaluate(() => window.processMap.model.size)) === before);

  // Export PNG.
  await A.mouse.click(700, 860);
  await A.click('button[aria-label=More]');
  const [download] = await Promise.all([A.waitForEvent('download'), A.click('text=Export image (PNG)')]);
  await download.saveAs(`${out}/09-export.png`);
  check('PNG export downloads', download.suggestedFilename().endsWith('.png'), download.suggestedFilename());

  await A.waitForTimeout(1500);
  await A.screenshot({ path: `${out}/10-admin-board.png` });

  // Viewer: read-only.
  const V = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  watch(V);
  await signIn(V, 'vic@example.com', vicPassword);
  await V.waitForSelector('dialog[open]');
  await V.fill('input[name=current]', vicPassword);
  await V.fill('input[name=next]', 'vic-own-password-2026');
  await V.fill('input[name=again]', 'vic-own-password-2026');
  await V.click('button:has-text("Save password")');
  await V.waitForSelector('.pm-mapcard');
  check('viewer has no New map button', (await V.locator('text=New map').count()) === 0);
  await V.goto(`${base}${href}`);
  await V.waitForSelector('.pm-node');
  const sizeBefore = await V.evaluate(() => window.processMap.model.size);
  await V.mouse.dblclick(900, 700);
  await V.keyboard.press('Delete');
  const sizeAfter = await V.evaluate(() => window.processMap.model.size);
  check('viewer cannot add or delete', sizeBefore === sizeAfter);
  check('viewer sees view-only pill', await V.isVisible('.pm-readonly'));
  await V.screenshot({ path: `${out}/11-viewer.png` });

  // List page with thumbnail.
  await A.goto(`${base}/maps/`);
  await A.waitForSelector('.pm-mapcard svg rect');
  await A.screenshot({ path: `${out}/12-list.png` });
  check('list card shows a thumbnail', (await A.locator('.pm-mapcard__thumb svg rect').count()) > 3);
}
