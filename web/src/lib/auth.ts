import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sqliteAdapter } from './auth-adapter';
import { dataDir } from './db';
import { isProduction, sendMail, signInEmail } from './mail';
import { syncModerators } from './repo/accounts';
import { enforceRateLimit, POLICY } from './ratelimit';
import { db, moderatorEmails } from './server';

/** Production must provide AUTH_SECRET. In development a random one is created once and kept in the data dir. */
function authSecret(): string {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  if (isProduction()) throw new Error('AUTH_SECRET must be set in production.');
  const file = path.join(dataDir(), '.dev-auth-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8');
  mkdirSync(dataDir(), { recursive: true });
  const secret = randomBytes(32).toString('base64');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export const googleEnabled = (): boolean => !!(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);

/** Passwordless email-link sign-in. Auth.js generates and verifies the one-time token. */
const emailProvider = {
  id: 'email',
  type: 'email' as const,
  name: 'Email',
  server: '',
  from: process.env.EMAIL_FROM,
  maxAge: 15 * 60,
  options: {},
  async sendVerificationRequest({ identifier, url }: { identifier: string; url: string }) {
    enforceRateLimit(db(), `signin:${identifier.trim().toLowerCase()}`, POLICY.signInEmail.limit, POLICY.signInEmail.windowMs);
    await sendMail(signInEmail(identifier, url));
  },
};

// Configuration is built lazily (per request) so `next build` never needs runtime secrets.
export const { handlers, auth, signIn, signOut } = NextAuth(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adapter: sqliteAdapter(db) as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  providers: [emailProvider as any, ...(googleEnabled() ? [Google({ clientId: process.env.AUTH_GOOGLE_ID, clientSecret: process.env.AUTH_GOOGLE_SECRET })] : [])],
  secret: authSecret(),
  session: { strategy: 'jwt' as const, maxAge: 30 * 24 * 3600 },
  // Behind a trusted proxy in production set AUTH_TRUST_HOST=true (and SITE_URL/AUTH_URL); never trust a spoofable Host header by default.
  trustHost: !isProduction() || process.env.AUTH_TRUST_HOST === 'true',
  pages: { signIn: '/sign-in', verifyRequest: '/sign-in/check-email', error: '/sign-in' },
  callbacks: {
    async signIn() {
      syncModerators(db(), moderatorEmails());
      return true;
    },
    jwt({ token, user }) {
      if (user?.id) token.uid = user.id;
      return token;
    },
    session({ session, token }) {
      if (token.uid) session.user.id = token.uid as string;
      return session;
    },
  },
}));
