import type { Metadata } from 'next';
import Link from 'next/link';
import { AvatarForm, DeleteAccountForm, ProfileForm } from '@/components/SettingsForms';
import { getProfile } from '@/lib/repo/accounts';
import { db } from '@/lib/server';
import { requireUserOrRedirect } from '@/lib/session';

export const metadata: Metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default async function Settings() {
  const user = await requireUserOrRedirect('/settings');
  const profile = getProfile(db(), user.id)!;
  return (
    <div className="narrow stack" style={{ margin: '0 auto', gap: 24 }}>
      <h1>Settings</h1>
      <section className="card-surface stack" aria-labelledby="profile">
        <h2 id="profile">Profile</h2>
        <div className="row">
          {profile.avatarId ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="avatar" src={`/media/${profile.avatarId}`} alt="Your avatar" width={64} height={64} />
          ) : (
            <span className="avatar" aria-hidden="true" />
          )}
          <p className="muted small">
            Public page: <Link href={`/creators/${profile.username}`}>/creators/{profile.username}</Link>
          </p>
        </div>
        <ProfileForm username={profile.username} displayName={profile.displayName} bio={profile.bio} />
      </section>
      <section className="card-surface stack" aria-labelledby="avatar-h">
        <h2 id="avatar-h">Avatar</h2>
        <AvatarForm hasAvatar={!!profile.avatarId} />
      </section>
      <section className="card-surface stack" aria-labelledby="account">
        <h2 id="account">Account</h2>
        <p className="muted small">Signed in as {user.email}. Your email is private and is never shown on your profile.</p>
        <DeleteAccountForm />
      </section>
    </div>
  );
}
