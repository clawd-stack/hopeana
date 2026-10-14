import { AppError, refuse } from './errors.ts';
import { env } from './env.ts';
import { cleanText, hasControlCharacters } from './text.ts';

/**
 * Request and response helpers shared by every function, so no endpoint
 * invents its own error shape or leaks an internal message.
 *
 * The pages and the API share an origin, so there is no CORS. Writes must be
 * JSON: a cross-site form cannot send application/json without a preflight
 * this API never answers, which together with the SameSite=Lax cookie closes
 * off cross-site request forgery.
 */

export const SESSION_COOKIE = 'pm_session';

export function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof AppError) {
    return json({ ok: false, code: error.code, message: error.userMessage, detail: error.detail }, error.status);
  }
  console.error('[process-maps] unhandled error', error);
  return json({ ok: false, code: 'INTERNAL', message: 'Something went wrong at our end. Please try again.' }, 500);
}

/**
 * Writes must come from this site's own pages. Browsers say where a request
 * came from in Sec-Fetch-Site, and in Origin; a sibling subdomain or any
 * other site is refused even though SameSite=Lax would let its cookie
 * through for a same-site request.
 */
export function requireSameOrigin(request: Request): void {
  if (request.method === 'GET' || request.method === 'HEAD') return;
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') refuse('FORBIDDEN', { reason: 'cross-site' });
  const origin = request.headers.get('origin');
  if (origin) {
    let host: string | null = null;
    try {
      host = new URL(origin).host;
    } catch {
      refuse('FORBIDDEN', { reason: 'origin' });
    }
    const expected = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? new URL(request.url).host;
    if (host !== expected) refuse('FORBIDDEN', { reason: 'origin' });
  }
}

/** Wraps a handler so every thrown error becomes a shaped response. */
export function handler(run: (request: Request) => Promise<Response>): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    try {
      requireSameOrigin(request);
      return await run(request);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export function requireMethod(request: Request, ...methods: string[]): void {
  if (!methods.includes(request.method)) refuse('INVALID_REQUEST', { allowed: methods });
}

export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  // The media type exactly: "text/plain; x=application/json" is a simple
  // request a cross-site form can send without a preflight.
  const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') refuse('INVALID_REQUEST', { expected: 'application/json' });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    refuse('INVALID_REQUEST');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) refuse('INVALID_REQUEST');
  return body as T;
}

/**
 * The path segment after a prefix: pathSegment(url, '/api/maps/') on
 * /api/maps/abc/sync is 'abc'. Returned undecoded: every id here is a uuid,
 * so anything needing decoding is not an id, and a malformed escape must not
 * be able to throw.
 */
export function pathSegment(request: Request, prefix: string): string | null {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length).split('/')[0] ?? '';
  return rest.length ? rest : null;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key !== name) continue;
    // A malformed cookie (planted by a sibling domain, say) is no cookie,
    // not a 500 on every request.
    try {
      return decodeURIComponent(rest.join('='));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Secure whenever the request came over HTTPS, read from the request itself
 * rather than from a deploy-context variable that functions may not see.
 */
export function isHttps(request: Request): boolean {
  return new URL(request.url).protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
}

export function setCookie(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure || env.isProduction) attributes.push('Secure');
  return attributes.join('; ');
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get('x-nf-client-connection-ip') ?? request.headers.get('x-forwarded-for');
  if (!forwarded) return null;
  const first = forwarded.split(',')[0]?.trim();
  return first && first.length > 0 ? first : null;
}

/** Trims, lowercases and sanity-checks an email without pretending to validate RFC 5322. */
export function normaliseEmail(value: unknown): string {
  if (typeof value !== 'string') refuse('INVALID_REQUEST', { field: 'email' });
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || hasControlCharacters(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    refuse('INVALID_REQUEST', { field: 'email' }, 'Please enter a valid email address.');
  }
  return email;
}

export function requireString(value: unknown, field: string, maxLength = 200): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    refuse('INVALID_REQUEST', { field });
  }
  const clean = cleanText(value, maxLength).trim();
  if (!clean) refuse('INVALID_REQUEST', { field });
  return clean;
}

export function optionalString(value: unknown, field: string, maxLength = 200): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > maxLength) refuse('INVALID_REQUEST', { field });
  return cleanText(value, maxLength).trim();
}
