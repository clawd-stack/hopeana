/**
 * First sign-in as the bootstrap admin and a new map from the swimlane template.
 */
export default async function run({ browser, base, out, check, watch }) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  watch(page);
  await page.goto(`${base}/maps/`);
  await page.fill('input[name=email]', 'admin@example.com');
  await page.fill('input[name=password]', 'local-admin-password');
  await page.click('button[type=submit]');
  await page.waitForSelector('.pm-page__head h1');
  await page.screenshot({ path: `${out}/01-empty-list.png` });
  check('the empty maps list shows no stray null or undefined', !/\b(null|undefined)\b/.test(await page.innerText('body')));
  await page.click('text=New map');
  await page.fill('input[name=name]', 'Employee onboarding to Xero');
  await page.fill('input[name=area]', 'Workforce');
  await page.screenshot({ path: `${out}/02-new-map.png` });
  await page.click('button:has-text("Create map")');
  await page.waitForURL(/board\.html/);
  await page.waitForSelector('.pm-node');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/03-board.png` });
  check('a new map opens with the swimlane template', (await page.locator('.pm-lane').count()) === 3);
  await page.click('button:has-text("Details")');
  await page.waitForSelector('.pm-panel:not([hidden])');
  check('the map details panel shows no stray null or undefined', !/\b(null|undefined)\b/.test(await page.innerText('.pm-panel')));
  await page.click('.pm-panel__head button');
  check('the board saves without errors', (await page.textContent('.pm-savestate')) === 'All changes saved');
}
