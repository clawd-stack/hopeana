/**
 * Environment access. Every secret is read here and nowhere else. Nothing in
 * this module reaches a browser: the web/ pages call the API, they never
 * import from src/.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const env = {
  /**
   * Postgres connection string. Netlify DB provisions the database and exposes
   * it as NETLIFY_DATABASE_URL; DATABASE_URL wins when set, so local work and
   * CI can point at their own Postgres without touching the deployed one.
   */
  get databaseUrl(): string {
    const url = process.env.DATABASE_URL ?? process.env.NETLIFY_DATABASE_URL;
    if (!url) throw new Error('No database connection string: set DATABASE_URL, or deploy where Netlify DB provides NETLIFY_DATABASE_URL');
    return url;
  },
  get hasDatabaseUrl(): boolean {
    return Boolean(process.env.DATABASE_URL ?? process.env.NETLIFY_DATABASE_URL);
  },
  /** Signing key for the session cookie. */
  get sessionSecret(): string {
    return required('SESSION_SECRET');
  },
  get hasSessionSecret(): boolean {
    return Boolean(process.env.SESSION_SECRET);
  },
  get isProduction(): boolean {
    return optional('CONTEXT', optional('NODE_ENV')) === 'production';
  },
};
