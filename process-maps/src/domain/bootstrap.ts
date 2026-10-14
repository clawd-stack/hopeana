import { hashPassword, verifyPassword } from '../lib/password.ts';
import type { Store } from '../store/types.ts';

/**
 * The first admin, from the environment, so there is a way in on a fresh
 * deploy without a password hash ever sitting in the repository.
 *
 * While ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD are set, that
 * address is an active admin whose password IS the value in the environment.
 * Both are made true on every sign-in attempt for that one address, which is
 * deterministic and self-healing. To own the password from the app instead,
 * remove ADMIN_BOOTSTRAP_PASSWORD once you are in; this then does nothing.
 */
export async function ensureBootstrapAdmin(store: Store, email: string): Promise<void> {
  const wanted = process.env.ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!wanted || !password || wanted !== email.toLowerCase()) return;

  let user = await store.users.getByEmail(wanted);
  if (!user) {
    user = await store.users.create({
      email: wanted,
      name: process.env.ADMIN_BOOTSTRAP_NAME?.trim() || 'Admin',
      role: 'admin',
      passwordHash: null,
      mustChange: false,
    });
    if (!user) return; // Lost a race with a concurrent attempt; that one wins.
    console.log(`[process-maps] bootstrap: created the admin account for ${wanted}`);
  } else if (!user.active || user.role !== 'admin') {
    await store.users.update(user.userId, { active: true, role: 'admin' });
    console.log(`[process-maps] bootstrap: reinstated admin access for ${wanted}`);
  }

  if (user.passwordHash && !user.mustChange && (await verifyPassword(password, user.passwordHash))) return;
  await store.users.setPassword(user.userId, await hashPassword(password), false);
}
