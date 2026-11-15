import { all, get, newId, run, tx, type Db } from '../db';
import { AppError, cleanBio, forbidden, notFound, unauthorized, validateDisplayName, validateUsername } from '../validation';

export interface User {
  id: string;
  email: string;
  role: 'user' | 'moderator';
  createdAt: number;
}

/** What other people may see. Never contains an email address. */
export interface Profile {
  userId: string;
  username: string;
  displayName: string;
  bio: string;
  avatarId: string | null;
  official: boolean;
  createdAt: number;
}

interface UserRow { id: string; email: string; email_verified: number | null; name: string | null; image: string | null; role: 'user' | 'moderator'; created_at: number }
interface ProfileRow { user_id: string; username: string; display_name: string; bio: string; avatar_id: string | null; official: number; created_at: number }

const toUser = (r: UserRow): User => ({ id: r.id, email: r.email, role: r.role, createdAt: r.created_at });
const toProfile = (r: ProfileRow): Profile => ({
  userId: r.user_id,
  username: r.username,
  displayName: r.display_name,
  bio: r.bio,
  avatarId: r.avatar_id,
  official: !!r.official,
  createdAt: r.created_at,
});

/** A private-by-default handle. It is NOT derived from the email address. */
function randomUsername(db: Db): string {
  for (let i = 0; i < 20; i++) {
    const candidate = `creator-${crypto.randomUUID().replace(/-/g, '').slice(0, 6)}`;
    if (!get(db, 'SELECT 1 AS x FROM profiles WHERE username = ?', candidate)) return candidate;
  }
  throw new AppError(500, 'Could not allocate a username.');
}

export function createUser(
  db: Db,
  input: { email: string; name?: string | null; image?: string | null; emailVerified?: number | null },
): User {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) throw new AppError(400, 'Enter a valid email address.', 'email');
  return tx(db, () => {
    const id = newId();
    const now = Date.now();
    run(db, 'INSERT INTO users (id, email, email_verified, name, image, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, email, input.emailVerified ?? null, input.name ?? null, input.image ?? null, 'user', now);
    // Public display name: the provider's name if any, otherwise a neutral placeholder (never the email).
    const display = (input.name ?? '').replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 40) || 'New creator';
    run(db, 'INSERT INTO profiles (user_id, username, display_name, bio, official, created_at) VALUES (?, ?, ?, ?, 0, ?)', id, randomUsername(db), display, '', now);
    return toUser(get<UserRow>(db, 'SELECT * FROM users WHERE id = ?', id)!);
  });
}

export const getUserById = (db: Db, id: string): User | null => {
  const r = get<UserRow>(db, 'SELECT * FROM users WHERE id = ?', id);
  return r ? toUser(r) : null;
};
export const getUserByEmail = (db: Db, email: string): User | null => {
  const r = get<UserRow>(db, 'SELECT * FROM users WHERE email = ?', email.trim().toLowerCase());
  return r ? toUser(r) : null;
};
export const getUserRowForAuth = (db: Db, id: string): UserRow | undefined => get<UserRow>(db, 'SELECT * FROM users WHERE id = ?', id);

export const getProfile = (db: Db, userId: string): Profile | null => {
  const r = get<ProfileRow>(db, 'SELECT * FROM profiles WHERE user_id = ?', userId);
  return r ? toProfile(r) : null;
};
export const getProfileByUsername = (db: Db, username: string): Profile | null => {
  const r = get<ProfileRow>(db, 'SELECT * FROM profiles WHERE username = ?', username.trim().toLowerCase());
  return r ? toProfile(r) : null;
};

export function updateProfile(db: Db, userId: string, input: { username: string; displayName: string; bio: string }): Profile {
  const username = validateUsername(input.username);
  const displayName = validateDisplayName(input.displayName);
  const bio = cleanBio(input.bio);
  const existing = getProfile(db, userId);
  if (!existing) throw notFound('That profile');
  // Official accounts keep their reserved handle; nobody else can take a reserved one.
  const nameChanged = username !== existing.username;
  try {
    run(db, 'UPDATE profiles SET username = ?, display_name = ?, bio = ? WHERE user_id = ?', nameChanged ? username : existing.username, displayName, bio, userId);
  } catch (e) {
    if (e instanceof Error && /UNIQUE/i.test(e.message)) throw new AppError(409, 'That username is already taken.', 'username');
    throw e;
  }
  return getProfile(db, userId)!;
}

/** Sets the avatar to a media item the user owns (or clears it with null). */
export function setAvatar(db: Db, userId: string, mediaId: string | null): void {
  if (mediaId) {
    const m = get<{ owner_id: string }>(db, 'SELECT owner_id FROM media WHERE id = ?', mediaId);
    if (!m || m.owner_id !== userId) throw forbidden('You can only use your own images.');
  }
  run(db, 'UPDATE profiles SET avatar_id = ? WHERE user_id = ?', mediaId, userId);
}

/**
 * Deletes the account and everything it owns (profile, themes, versions, previews, saves, uploads...).
 * Returns the stored image files so the caller can remove them from disk.
 */
export function deleteAccount(db: Db, userId: string): string[] {
  if (!getUserById(db, userId)) throw unauthorized();
  return tx(db, () => {
    const files = all<{ file: string }>(db, 'SELECT file FROM media WHERE owner_id = ?', userId).map((r) => r.file);
    // Reports the user filed stay (anonymised by ON DELETE SET NULL); moderation history is kept.
    run(db, 'DELETE FROM users WHERE id = ?', userId);
    return files;
  });
}

/** Makes the listed emails moderators (called at sign-in from MODERATOR_EMAILS). */
export function syncModerators(db: Db, emails: string[]): void {
  for (const e of emails.map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    run(db, "UPDATE users SET role = 'moderator' WHERE email = ?", e);
  }
}

export function requireUser(db: Db, userId: string | null | undefined): User {
  if (!userId) throw unauthorized();
  const u = getUserById(db, userId);
  if (!u) throw unauthorized();
  return u;
}

/** Moderator status is always read from the database, never from a token or cookie. */
export function requireModerator(db: Db, userId: string | null | undefined): User {
  const u = requireUser(db, userId);
  if (u.role !== 'moderator') throw forbidden('Moderators only.');
  return u;
}

/** The accurately labelled studio account that owns the starter themes. Created by the seed script only. */
export function ensureOfficialAccount(db: Db, input: { email: string; username: string; displayName: string; bio: string }): Profile {
  const existing = getUserByEmail(db, input.email);
  const user = existing ?? createUser(db, { email: input.email, name: input.displayName, emailVerified: Date.now() });
  run(db, 'UPDATE profiles SET username = ?, display_name = ?, bio = ?, official = 1 WHERE user_id = ?', input.username, input.displayName, input.bio, user.id);
  return getProfile(db, user.id)!;
}
