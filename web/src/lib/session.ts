import { redirect } from 'next/navigation';
import { auth } from './auth';
import { getProfile, getUserById, type Profile, type User } from './repo/accounts';
import { db } from './server';
import { unauthorized } from './validation';

/**
 * The signed-in user, re-read from the database on EVERY call. The session token only carries an id,
 * so a deleted account (or a changed role) takes effect immediately; roles are never trusted from a cookie.
 */
export async function currentUser(): Promise<User | null> {
  const session = await auth();
  const id = session?.user?.id;
  return id ? getUserById(db(), id) : null;
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
