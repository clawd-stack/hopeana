import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

// promisify resolves to the three-argument overload, which loses the cost
// parameters. Name the signature we actually call.
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * Password hashing.
 *
 * scrypt, from node:crypto. Not a design preference so much as the only
 * memory-hard KDF available without a native dependency: bcrypt and argon2 both
 * need compiled bindings, which is a poor trade in a serverless bundle. A plain
 * SHA-256 would be the wrong answer entirely, because the whole point of a
 * password hash is to be slow.
 *
 * The cost parameters are stored inside each hash rather than fixed in code, so
 * they can be raised later without invalidating a single existing password:
 * verify reads the parameters the hash was made with, and any hash below the
 * current cost is re-hashed on the next successful sign-in.
 *
 *   scrypt$N$r$p$<salt base64>$<hash base64>
 */

/** 2^15 with r=8 needs 32MB per hash. Raise N, not the format, when hardware allows. */
const COST_N = 32768;
const COST_R = 8;
const COST_P = 1;
const KEY_LENGTH = 32;
const SALT_BYTES = 16;
/** scrypt needs roughly 128 * N * r bytes; give it headroom or it throws. */
const MAX_MEMORY = 128 * COST_N * COST_R * 2;

/**
 * The shortest password we will accept. Long beats clever, so length is the
 * only property worth insisting on.
 */
export const MINIMUM_PASSWORD_LENGTH = 12;
/** Bcrypt's 72-byte truncation is not our problem, but unbounded input is. */
export const MAXIMUM_PASSWORD_LENGTH = 200;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N: COST_N,
    r: COST_R,
    p: COST_P,
    maxmem: MAX_MEMORY,
  });
  return `scrypt$${COST_N}$${COST_R}$${COST_P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(password.normalize('NFKC'), parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: 128 * parsed.N * parsed.r * 2,
    });
  } catch {
    // Unusable parameters in a stored hash: refuse rather than throw, so one
    // corrupt row cannot take the sign-in endpoint down.
    return false;
  }
  return derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash);
}

/**
 * Whether a stored hash was made with weaker parameters than we now use, and
 * should be rewritten on the next successful sign-in.
 */
export function needsRehash(stored: string): boolean {
  const parsed = parse(stored);
  if (!parsed) return true;
  return parsed.N < COST_N || parsed.r < COST_R || parsed.p < COST_P;
}

/**
 * A password an admin can read out and a teammate can type once.
 *
 * Deliberately not the full alphabet: 0/O and 1/l/I are gone, so a password
 * that is going to be transcribed by hand at least once does not generate a
 * support call. 20 characters from a 31-symbol alphabet is just under 99 bits,
 * far past anything the rate limiter would ever let through.
 *
 * No separators: the stored value is exactly what the person types.
 */
const READABLE = 'abcdefghjkmnpqrstuvwxyz23456789';

export function generatePassword(length = 20): string {
  // Rejection sampling: taking a raw byte modulo 31 would bias the first few
  // letters, and a biased password generator is a subtle way to be wrong.
  const out: string[] = [];
  const limit = 256 - (256 % READABLE.length);
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= limit) continue;
      out.push(READABLE[byte % READABLE.length]!);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

/**
 * A password is whatever the person typed. The only thing taken off is
 * surrounding whitespace, which is a paste artefact rather than a choice, and
 * the one transformation that cannot silently weaken anything.
 */
export function readPassword(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export interface PasswordProblem {
  message: string;
}

export function validatePassword(password: string): PasswordProblem | null {
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    return { message: `Please use at least ${MINIMUM_PASSWORD_LENGTH} characters.` };
  }
  if (password.length > MAXIMUM_PASSWORD_LENGTH) {
    return { message: `Please use no more than ${MAXIMUM_PASSWORD_LENGTH} characters.` };
  }
  return null;
}

function parse(stored: string): { N: number; r: number; p: number; salt: Buffer; hash: Buffer } | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, n, r, p, salt, hash] = parts;
  const parsed = { N: Number(n), r: Number(r), p: Number(p) };
  if (!Number.isInteger(parsed.N) || !Number.isInteger(parsed.r) || !Number.isInteger(parsed.p)) return null;
  if (parsed.N < 2 || parsed.r < 1 || parsed.p < 1) return null;
  return { ...parsed, salt: Buffer.from(salt!, 'base64'), hash: Buffer.from(hash!, 'base64') };
}

/**
 * A hash of a password nobody has, for the no-such-account path.
 *
 * Without this, a sign-in for an unknown address returns in a millisecond while
 * a real one takes the full scrypt cost, and the difference tells a caller who
 * has an account. Verifying against this instead keeps the two paths the
 * same shape.
 */
export const DUMMY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
