/**
 * Local server: the web pages plus every function under netlify/functions,
 * routed by each function's own `config.path`, without needing the Netlify
 * CLI. For local work and the browser tests only; never deployed.
 *
 *   npm run serve                      in-memory store, nothing persists
 *   DATABASE_URL=postgres://... npm run serve
 *
 * With no ADMIN_BOOTSTRAP_EMAIL set, it signs in a local admin
 * (admin@example.com / local-admin-password) so there is a way in.
 */
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const webRoot = join(root, 'web');
const port = Number(process.env.PORT ?? 8888);

process.env.SESSION_SECRET ??= 'local-dev-secret-not-for-deploy';
// Without a database, hold everything in memory. Deployed code never does.
if (!process.env.DATABASE_URL) process.env.PROCESS_MAPS_MEMORY_STORE = '1';
if (!process.env.ADMIN_BOOTSTRAP_EMAIL) {
  process.env.ADMIN_BOOTSTRAP_EMAIL = 'admin@example.com';
  process.env.ADMIN_BOOTSTRAP_PASSWORD = 'local-admin-password';
  process.env.ADMIN_BOOTSTRAP_NAME ??= 'Local Admin';
}

const routes = [];
for (const file of (await readdir(join(root, 'netlify/functions'))).filter((f) => f.endsWith('.ts'))) {
  const mod = await import(join(root, 'netlify/functions', file));
  const paths = [].concat(mod.config?.path ?? []);
  for (const path of paths) {
    const pattern = new RegExp(`^${path.replace(/:[A-Za-z]+/g, '[^/]+')}$`);
    routes.push({ pattern, run: mod.default, specificity: path.split('/').length });
  }
}
routes.sort((a, b) => b.specificity - a.specificity);

// Mirrors the headers in netlify.toml, so local runs and the browser tests
// would surface anything that breaks the deployed Content-Security-Policy.
const SECURITY_HEADERS = {
  'x-frame-options': 'SAMEORIGIN',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

async function serveStatic(pathname, res) {
  if (pathname === '/') {
    res.writeHead(302, { location: '/maps/' });
    return res.end();
  }
  let file = normalize(join(webRoot, decodeURIComponent(pathname)));
  if (!file.startsWith(webRoot)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const route = routes.find((r) => r.pattern.test(url.pathname));
  if (!route) return serveStatic(url.pathname, res);

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
  headers.set('x-nf-client-connection-ip', req.socket.remoteAddress ?? '127.0.0.1');
  const request = new Request(url, {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(chunks),
  });
  const response = await route.run(request, {});
  const out = {};
  response.headers.forEach((value, key) => {
    if (key !== 'set-cookie') out[key] = value;
  });
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length) out['set-cookie'] = cookies;
  res.writeHead(response.status, out);
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => {
  console.log(`process maps on http://localhost:${port}/maps/`);
  if (process.env.ADMIN_BOOTSTRAP_EMAIL === 'admin@example.com') {
    console.log('sign in as admin@example.com / local-admin-password');
  }
});
