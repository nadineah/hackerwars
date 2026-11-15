import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { AuthError } from 'next-auth';
import { googleEnabled, signIn } from '@/lib/auth';
import { emailDeliveryMode } from '@/lib/mail';
import { safeNext } from '@/lib/next-url';
import { currentUser } from '@/lib/session';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

const ERRORS: Record<string, string> = {
  Verification: 'That sign-in link has expired or was already used. Request a new one below.',
  AccessDenied: 'Sign-in was not allowed.',
  Configuration: 'Sign-in is not configured correctly on this server.',
  OAuthAccountNotLinked: 'That email is already used with another sign-in method. Use the method you used before.',
  Default: 'We could not sign you in. Please try again.',
};

export default async function SignIn({ searchParams }: { searchParams: Promise<{ next?: string; error?: string; sent?: string; msg?: string }> }) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  if (await currentUser()) redirect(next);

  async function emailAction(fd: FormData) {
    'use server';
    const email = String(fd.get('email') ?? '').trim().toLowerCase();
    const dest = safeNext(String(fd.get('next') ?? '/'));
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) redirect(`/sign-in?msg=${encodeURIComponent('Enter a valid email address.')}&next=${encodeURIComponent(dest)}`);
    try {
      await signIn('email', { email, redirectTo: dest, redirect: false });
    } catch (e) {
      if (e instanceof AuthError) redirect(`/sign-in?error=${encodeURIComponent(e.type)}&next=${encodeURIComponent(dest)}`);
      console.error('[sign-in]', e);
      redirect(`/sign-in?msg=${encodeURIComponent('We could not send the sign-in email. Please try again in a moment.')}&next=${encodeURIComponent(dest)}`);
    }
    redirect(`/sign-in/check-email?email=${encodeURIComponent(email)}`);
  }

  async function googleAction(fd: FormData) {
    'use server';
    await signIn('google', { redirectTo: safeNext(String(fd.get('next') ?? '/')) });
  }

  const error = sp.error ? ERRORS[sp.error] ?? ERRORS.Default : sp.msg;
  const mode = emailDeliveryMode();

  return (
    <div className="narrow" style={{ margin: '0 auto' }}>
      <h1>Sign in</h1>
      <p className="muted">No password needed. You do not need an account to browse or apply public themes. You need one to save themes and to publish.</p>
      {error && <div className="alert error" role="alert" style={{ marginBottom: 16 }}>{error}</div>}
      {mode === 'none' && <div className="alert warn" style={{ marginBottom: 16 }}>Email sign-in is not configured on this server yet.</div>}
      <div className="card-surface stack">
        <form action={emailAction} className="stack">
          <input type="hidden" name="next" value={next} />
          <div className="field">
            <label htmlFor="email">Email address</label>
            <input id="email" name="email" type="email" required autoComplete="email" inputMode="email" placeholder="you@example.com" />
            <p className="hint">We email you a one-time link. Your email stays private and is never shown on your profile.</p>
          </div>
          <button className="btn block" type="submit" disabled={mode === 'none'}>Email me a sign-in link</button>
        </form>
        {googleEnabled() && (
          <>
            <hr style={{ border: 0, borderTop: '1px solid var(--line)', width: '100%' }} />
            <form action={googleAction}>
              <input type="hidden" name="next" value={next} />
              <button className="btn secondary block" type="submit">Continue with Google</button>
            </form>
          </>
        )}
      </div>
      {mode === 'dev-file' && (
        <p className="alert info small" style={{ marginTop: 16 }}>
          Development mode: no email provider is set, so the sign-in link is printed in the server console and listed at <a href="/dev/mail">/dev/mail</a>.
        </p>
      )}
    </div>
  );
}
