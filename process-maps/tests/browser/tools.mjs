/**
 * Every tool on the rail, resize, lanes carrying their contents, the
 * clipboard, a reload from the server, and the phone layout.
 */
export default async function run({ browser, base, out, check, watch }) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] })).newPage();
  watch(page);
  const items = () => page.evaluate(() => window.processMap.model.all());

  await page.goto(`${base}/maps/`);
  await page.fill('input[name=email]', 'admin@example.com');
  await page.fill('input[name=password]', 'local-admin-password');
  await page.click('button[type=submit]');
  await page.waitForSelector('.pm-page__head h1');
  await page.click('text=New map');
  await page.fill('input[name=name]', 'Blank test');
  await page.click('label.pm-template:has-text("Blank")');
  await page.click('dialog button[type=submit]');
  await page.waitForURL(/board\.html/);
  await page.waitForSelector('.pm-tools');

  // Lane tool via keyboard, click to place, type a name.
  await page.keyboard.press('l');
  await page.mouse.click(200, 150);
  await page.keyboard.type('HR');
  await page.keyboard.press('Enter');
  let all = await items();
  check('lane created with name', all.some((i) => i.kind === 'lane' && i.text === 'HR'));
  // Add lane below from the context toolbar.
  await page.click('.pm-lane__head');
  await page.click('button:has-text("Lane below")');
  await page.keyboard.type('Payroll');
  await page.keyboard.press('Enter');
  all = await items();
  const lanes = all.filter((i) => i.kind === 'lane').sort((a, b) => a.y - b.y);
  check('lane below stacks under the first', lanes.length === 2 && lanes[1].y === lanes[0].y + lanes[0].h, lanes.map((l) => `${l.text}@${l.y}`).join(', '));

  // Step tool: click inside lane one, type.
  await page.keyboard.press('Escape');
  await page.keyboard.press('r');
  await page.mouse.click(420, 250);
  await page.keyboard.type('Collect TFN form');
  await page.mouse.click(1300, 820);
  // Decision with the shape menu: select step, change to decision.
  await page.locator('.pm-node--step', { hasText: 'Collect TFN' }).click();
  await page.locator('.pm-context button[aria-label="Change shape"]').click();
  await page.click('.pm-menu button:has-text("Decision")');
  all = await items();
  check('shape changed to decision', all.some((i) => i.kind === 'decision' && i.text === 'Collect TFN form'));
  await page.keyboard.press('Control+z');
  all = await items();
  check('undo restores the step', all.some((i) => i.kind === 'step' && i.text === 'Collect TFN form'));

  // Resize the step from its bottom-right handle.
  await page.locator('.pm-node--step', { hasText: 'Collect TFN' }).click();
  const se = await page.locator('.pm-handle[data-dir=se]').boundingBox();
  const w0 = (await items()).find((i) => i.text === 'Collect TFN form').w;
  await page.mouse.move(se.x + 5, se.y + 5);
  await page.mouse.down();
  await page.mouse.move(se.x + 85, se.y + 45, { steps: 6 });
  await page.mouse.up();
  const w1 = (await items()).find((i) => i.text === 'Collect TFN form').w;
  check('resize widens the step', w1 > w0 + 50, `${w0} -> ${w1}`);

  // Moving the lane carries the step inside it.
  const stepBefore = (await items()).find((i) => i.text === 'Collect TFN form');
  const head = await page.locator('.pm-lane__head').first().boundingBox();
  await page.mouse.move(head.x + 20, head.y + 40);
  await page.mouse.down();
  await page.mouse.move(head.x + 20, head.y + 140, { steps: 6 });
  await page.mouse.up();
  const stepAfter = (await items()).find((i) => i.text === 'Collect TFN form');
  check('lane carries its contents', stepAfter.y > stepBefore.y + 50, `${stepBefore.y} -> ${stepAfter.y}`);
  await page.keyboard.press('Control+z');

  // Keys pressed mid-drag are ignored, so the drag stays one undo step.
  const dragStep = await page.locator('.pm-node--step', { hasText: 'Collect TFN' }).boundingBox();
  const x0 = (await items()).find((i) => i.text === 'Collect TFN form').x;
  await page.mouse.move(dragStep.x + 20, dragStep.y + 20);
  await page.mouse.down();
  await page.mouse.move(dragStep.x + 60, dragStep.y + 20, { steps: 4 });
  await page.keyboard.press('Control+z');
  await page.keyboard.press('ArrowRight');
  await page.mouse.move(dragStep.x + 120, dragStep.y + 20, { steps: 4 });
  await page.mouse.up();
  const x1 = (await items()).find((i) => i.text === 'Collect TFN form').x;
  await page.keyboard.press('Control+z');
  const x2 = (await items()).find((i) => i.text === 'Collect TFN form').x;
  check('a drag is one undo step even with keys pressed during it', x1 !== x0 && x2 === x0, `${x0} -> ${x1} -> ${x2}`);

  // Text tool.
  await page.keyboard.press('t');
  await page.mouse.click(700, 700);
  await page.keyboard.type('Onboarding today: about 3 hours per person');
  await page.mouse.click(1300, 820);
  check('text item created', (await items()).some((i) => i.kind === 'text' && i.text.startsWith('Onboarding today')));

  // Connector tool between two shapes.
  await page.keyboard.press('o');
  await page.mouse.click(420, 520);
  await page.keyboard.type('Start');
  await page.mouse.click(1300, 820);
  await page.keyboard.press('c');
  const startBox = await page.locator('.pm-node--terminal', { hasText: 'Start' }).boundingBox();
  const stepBox = await page.locator('.pm-node--step', { hasText: 'Collect TFN' }).boundingBox();
  await page.mouse.move(startBox.x + startBox.width / 2, startBox.y + startBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(stepBox.x + stepBox.width / 2, stepBox.y + stepBox.height / 2, { steps: 8 });
  await page.mouse.up();
  const link = (await items()).find((i) => i.kind === 'connector');
  check('connector tool links two shapes', Boolean(link && link.from.id && link.to.id));
  // Label the connector by double-clicking it.
  await page.waitForTimeout(100);
  const route = await page.evaluate((id) => window.processMap.renderer.route(id), link.id);
  const mid = route[Math.floor(route.length / 2)];
  const sp = await page.evaluate((p) => window.processMap.camera.toScreen(p.x, p.y), mid);
  await page.mouse.dblclick(sp.x, sp.y);
  await page.keyboard.type('New starter');
  await page.keyboard.press('Enter');
  check('connector label typed', (await items()).some((i) => i.kind === 'connector' && i.text === 'New starter'));

  // Copy and paste through the real clipboard events.
  await page.locator('.pm-node--step', { hasText: 'Collect TFN' }).click();
  const beforePaste = (await items()).length;
  await page.keyboard.press('Control+c');
  await page.mouse.move(900, 300);
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(150);
  check('copy and paste adds a copy', (await items()).length === beforePaste + 1, `${beforePaste} -> ${(await items()).length}`);
  await page.keyboard.press('Control+z');

  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/13-tools.png` });
  const pending = await page.evaluate(() => window.processMap.model.pending);
  check('everything saved', pending === 0);

  // Reload: the board comes back from the server as left.
  const count = (await items()).length;
  await page.reload();
  await page.waitForSelector('.pm-node');
  check('reload shows the same board', (await items()).length === count, `${count} items`);

  // Phone layout.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true })).newPage();
  watch(phone);
  await phone.goto(`${base}/maps/`);
  await phone.fill('input[name=email]', 'admin@example.com');
  await phone.fill('input[name=password]', 'local-admin-password');
  await phone.click('button[type=submit]');
  await phone.waitForSelector('.pm-mapcard');
  await phone.screenshot({ path: `${out}/14-phone-list.png` });
  await phone.click('.pm-mapcard');
  await phone.waitForSelector('.pm-node');
  await phone.waitForTimeout(400);
  await phone.screenshot({ path: `${out}/15-phone-board.png` });
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  check('no sideways scroll on phone', !overflow);
}
