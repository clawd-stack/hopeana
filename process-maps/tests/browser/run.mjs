/**
 * Browser tests: the real pages in Chromium against the local server.
 *
 *   npm run test:browser                     in-memory store
 *   DATABASE_URL=postgres://... npm run test:browser   an EMPTY database, migrated
 *
 * The scenarios add the same people every run, so against a database that
 * already holds them the team step stops at "email already taken".
 *
 * Starts scripts/dev-server.mjs on a spare port, runs each scenario in order
 * (later ones use what earlier ones made), and fails on any failed check or
 * any console error or uncaught exception in the page. Screenshots go to
 * BROWSER_TEST_OUT, or a temporary folder.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../..', import.meta.url));
const port = Number(process.env.BROWSER_TEST_PORT ?? 8890);
const base = `http://localhost:${port}`;
const out = process.env.BROWSER_TEST_OUT ?? mkdtempSync(join(tmpdir(), 'process-maps-'));
mkdirSync(out, { recursive: true });

const server = spawn(process.execPath, ['scripts/dev-server.mjs'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), ADMIN_BOOTSTRAP_EMAIL: '', SESSION_SECRET: 'browser-test-secret' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

for (let i = 0; i < 50; i++) {
  try {
    await fetch(`${base}/api/health`);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}

const failures = [];
const problems = [];
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`);
  if (!ok) failures.push(label);
};
const watch = (page) => {
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`[console] ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
};

const browser = await chromium.launch();
let crashed = null;
try {
  for (const name of ['smoke', 'collab', 'tools']) {
    console.log(`\n# ${name}`);
    const { default: run } = await import(`./${name}.mjs`);
    await run({ browser, base, out, check, watch });
    // Each scenario starts with nobody else's tabs still open.
    for (const context of browser.contexts()) await context.close();
  }
} catch (error) {
  crashed = error;
} finally {
  await browser.close();
  server.kill();
}

if (problems.length) console.log(`\nPage errors:\n${problems.join('\n')}`);
if (crashed) console.log(`\nA scenario stopped early:\n${crashed.stack ?? crashed}\n\nServer log:\n${serverLog.slice(-4000)}`);
console.log(`\nScreenshots: ${out}`);
if (crashed || failures.length || problems.length) {
  console.log(`${failures.length} check(s) failed, ${problems.length} page error(s).`);
  process.exit(1);
}
console.log('All browser checks passed.');
