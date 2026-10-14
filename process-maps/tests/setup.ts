/**
 * Test environment. DATABASE_URL is deliberately left alone: the suite runs
 * against the in-memory store, and the Postgres contract run opts in when
 * DATABASE_URL is present.
 */
process.env.SESSION_SECRET ??= 'test-secret-not-used-anywhere-real';
delete process.env.ADMIN_BOOTSTRAP_EMAIL;
delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
