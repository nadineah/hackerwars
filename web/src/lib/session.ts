import { redirect } from 'next/navigation';
import { auth } from './auth';
import { getProfile, getUserById, syncModerators, type Profile, type User } from './repo/accounts';
import { db, moderatorEmails } from './server';
import { unauthorized } from './validation';

/**
 * The signed-in user, re-read from the database on EVERY call. The session token only carries an id,
 * so a deleted account (or a changed role) takes effect immediately; roles are never trusted from a cookie.
 */
export async function currentUser(): Promise<User | null> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;
  let user = getUserById(db(), id);
  // A new account is created after the sign-in callback runs, so promote configured moderators here as well.
  if (user && user.role !== 'moderator' && moderatorEmails().map((e) => e.toLowerCase()).includes(user.email.toLowerCase())) {
    syncModerators(db(), moderatorEmails());
    user = getUserById(db(), id);
  }
  return user;
}

export async function currentProfile(): Promise<Profile | null> {
  const u = await currentUser();
  return u ? getProfile(db(), u.id) : null;
}

/** For pages: send signed-out visitors to the sign-in page, returning them afterwards. */
export async function requireUserOrRedirect(next: string): Promise<User> {
  const u = await currentUser();
  if (!u) redirect(`/sign-in?next=${encodeURIComponent(next)}`);
  return u;
}

/** For actions and API routes: fail with 401. */
export async function requireUserOrThrow(): Promise<User> {
  const u = await currentUser();
  if (!u) throw unauthorized();
  return u;
}
