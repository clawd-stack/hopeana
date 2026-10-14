import { publicUser } from '../lib/auth.ts';
import { AppError, refuse } from '../lib/errors.ts';
import { normaliseEmail, requireString } from '../lib/http.ts';
import { generatePassword, hashPassword } from '../lib/password.ts';
import { ROLES, type Role, type Store, type UserRecord } from '../store/types.ts';

/**
 * The team: who can sign in, and what they can do.
 *
 *   admin   edits maps and manages the team
 *   editor  edits maps
 *   viewer  reads maps
 *
 * An admin issues each password. It is shown once, to the admin, and is marked
 * must-change so the person replaces it with one only they know. Standalone
 * only: inside Peggy, Peggy's own user management takes over.
 */

function readRole(value: unknown): Role {
  if (typeof value !== 'string' || !(ROLES as readonly string[]).includes(value)) refuse('INVALID_REQUEST', { field: 'role' });
  return value as Role;
}

export async function listTeam(store: Store) {
  return (await store.users.list()).map(publicUser);
}

export async function addTeamMember(store: Store, body: Record<string, unknown>) {
  const email = normaliseEmail(body.email);
  const name = requireString(body.name, 'name', 80);
  const role = body.role === undefined ? 'editor' : readRole(body.role);
  const password = generatePassword();
  const user = await store.users.create({ email, name, role, passwordHash: await hashPassword(password), mustChange: true });
  if (!user) throw new AppError('EMAIL_TAKEN');
  return { user: publicUser(user), password };
}

export async function updateTeamMember(store: Store, admin: UserRecord, userId: string, body: Record<string, unknown>) {
  const target = await store.users.get(userId);
  if (!target) refuse('NOT_FOUND', null, 'That person could not be found.');

  const patch: { name?: string; role?: Role; active?: boolean } = {};
  if (body.name !== undefined) patch.name = requireString(body.name, 'name', 80);
  if (body.role !== undefined) patch.role = readRole(body.role);
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') refuse('INVALID_REQUEST', { field: 'active' });
    patch.active = body.active;
  }
  // The one way to lock everybody out is to remove the last admin, and the
  // simplest guard against it is that nobody can remove their own access.
  if (target.userId === admin.userId && ((patch.role && patch.role !== 'admin') || patch.active === false)) {
    throw new AppError('CANNOT_CHANGE_SELF');
  }

  let password: string | null = null;
  if (body.resetPassword === true) {
    password = generatePassword();
    await store.users.setPassword(target.userId, await hashPassword(password), true);
  }
  const updated = Object.keys(patch).length ? await store.users.update(target.userId, patch) : await store.users.get(target.userId);
  if (!updated) refuse('NOT_FOUND');
  return { user: publicUser(updated), password };
}
