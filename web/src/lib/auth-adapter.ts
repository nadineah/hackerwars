import type { Adapter, AdapterAccount, AdapterUser, VerificationToken } from '@auth/core/adapters';
import { get, run, type Db } from './db';
import { createUser, getUserById, getUserByEmail } from './repo/accounts';

/**
 * Auth.js adapter on the app's own SQLite database. Sessions are JWTs (so no session table); this stores
 * users, linked OAuth accounts and the one-time email sign-in tokens. Passwords are never involved.
 */
interface UserRow { id: string; email: string; email_verified: number | null; name: string | null; image: string | null }

const toAdapterUser = (r: UserRow): AdapterUser => ({
  id: r.id,
  email: r.email,
  emailVerified: r.email_verified ? new Date(r.email_verified) : null,
  name: r.name,
  image: r.image,
});

export function sqliteAdapter(getDb: () => Db): Adapter {
  return {
    createUser(user) {
      const u = createUser(getDb(), {
        email: user.email,
        name: user.name ?? null,
        image: user.image ?? null,
        emailVerified: user.emailVerified ? user.emailVerified.getTime() : null,
      });
      return toAdapterUser(get<UserRow>(getDb(), 'SELECT * FROM users WHERE id = ?', u.id)!);
    },

    getUser(id) {
      const r = get<UserRow>(getDb(), 'SELECT * FROM users WHERE id = ?', id);
      return r ? toAdapterUser(r) : null;
    },

    getUserByEmail(email) {
      const u = getUserByEmail(getDb(), email);
      if (!u) return null;
      return toAdapterUser(get<UserRow>(getDb(), 'SELECT * FROM users WHERE id = ?', u.id)!);
    },

    getUserByAccount({ provider, providerAccountId }) {
      const r = get<UserRow>(
        getDb(),
        'SELECT u.* FROM users u JOIN accounts a ON a.user_id = u.id WHERE a.provider = ? AND a.provider_account_id = ?',
        provider,
        providerAccountId,
      );
      return r ? toAdapterUser(r) : null;
    },

    updateUser(patch) {
      const db = getDb();
      if (!getUserById(db, patch.id)) throw new Error('User not found');
      // Only fields Auth.js legitimately updates; never the role (that comes from config).
      if (patch.emailVerified !== undefined) run(db, 'UPDATE users SET email_verified = ? WHERE id = ?', patch.emailVerified ? patch.emailVerified.getTime() : null, patch.id);
      if (patch.name !== undefined) run(db, 'UPDATE users SET name = ? WHERE id = ?', patch.name ?? null, patch.id);
      if (patch.image !== undefined) run(db, 'UPDATE users SET image = ? WHERE id = ?', patch.image ?? null, patch.id);
      return toAdapterUser(get<UserRow>(db, 'SELECT * FROM users WHERE id = ?', patch.id)!);
    },

    linkAccount(account: AdapterAccount) {
      run(getDb(), 'INSERT OR IGNORE INTO accounts (provider, provider_account_id, user_id, type) VALUES (?, ?, ?, ?)', account.provider, account.providerAccountId, account.userId, account.type);
      return account;
    },

    createVerificationToken(token: VerificationToken) {
      run(getDb(), 'INSERT INTO verification_tokens (identifier, token, expires) VALUES (?, ?, ?)', token.identifier, token.token, token.expires.getTime());
      return token;
    },

    /** One-time use: the token is deleted the moment it is read, whether or not it has expired. */
    useVerificationToken({ identifier, token }) {
      const db = getDb();
      const row = get<{ identifier: string; token: string; expires: number }>(db, 'SELECT * FROM verification_tokens WHERE identifier = ? AND token = ?', identifier, token);
      if (!row) return null;
      run(db, 'DELETE FROM verification_tokens WHERE identifier = ? AND token = ?', identifier, token);
      return { identifier: row.identifier, token: row.token, expires: new Date(row.expires) };
    },
  };
}
