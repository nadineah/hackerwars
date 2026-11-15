import Image from 'next/image';
import Link from 'next/link';
import { signOut } from '@/lib/auth';
import { getProfile } from '@/lib/repo/accounts';
import { currentUser } from '@/lib/session';
import { db } from '@/lib/server';

export default async function Header() {
  const user = await currentUser();
  const profile = user ? getProfile(db(), user.id) : null;

  async function signOutAction() {
    'use server';
    await signOut({ redirectTo: '/' });
  }

  return (
    <header className="site-header">
      <div className="container">
        <Link href="/" className="brand" aria-label="WhimsyWeb home">
          <Image src="/logo.png" alt="" width={34} height={34} priority />
          <span>WhimsyWeb</span>
        </Link>
        <nav className="nav" aria-label="Main">
          <Link href="/explore">Explore</Link>
          {user ? (
            <>
              <Link href="/library">My library</Link>
              <Link href="/publish">Publish</Link>
              {user.role === 'moderator' && <Link href="/moderation">Moderation</Link>}
              <Link href="/settings">{profile?.displayName ?? 'Account'}</Link>
              <form action={signOutAction}>
                <button type="submit" className="linklike">Sign out</button>
              </form>
            </>
          ) : (
            <>
              <Link href="/install">Get the extension</Link>
              <Link href="/sign-in" className="btn small">Sign in</Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
