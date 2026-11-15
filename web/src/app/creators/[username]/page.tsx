import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import ThemeCard from '@/components/ThemeCard';
import { getProfileByUsername } from '@/lib/repo/accounts';
import { listThemesByCreator } from '@/lib/repo/themes';
import { db } from '@/lib/server';

export const dynamic = 'force-dynamic';
type Params = { username: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { username } = await params;
  const p = getProfileByUsername(db(), username);
  return { title: p ? `${p.displayName} (@${p.username})` : 'Creator not found' };
}

/** Public profile: display name, avatar, bio, join date and PUBLISHED themes only. Never email, drafts or saves. */
export default async function Creator({ params }: { params: Promise<Params> }) {
  const { username } = await params;
  const profile = getProfileByUsername(db(), username);
  if (!profile) notFound();
  const published = listThemesByCreator(db(), profile.username);
  return (
    <>
      <div className="profile-head">
        {profile.avatarId ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="avatar" src={`/media/${profile.avatarId}`} alt="" width={88} height={88} />
        ) : (
          <div className="avatar" aria-hidden="true">{profile.displayName.slice(0, 1).toUpperCase()}</div>
        )}
        <div>
          <h1 style={{ margin: 0 }}>
            {profile.displayName}
            {profile.official && <span className="badge official" style={{ marginLeft: 10, verticalAlign: 'middle' }}>Official</span>}
          </h1>
          <p className="muted" style={{ margin: '4px 0' }}>@{profile.username} · joined {new Date(profile.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long' })}</p>
          {profile.bio && <p style={{ margin: 0 }}>{profile.bio}</p>}
        </div>
      </div>
      <h2>{published.length === 1 ? '1 theme' : `${published.length} themes`}</h2>
      {published.length > 0 ? (
        <div className="grid">{published.map((t) => <ThemeCard key={t.id} theme={t} />)}</div>
      ) : (
        <div className="empty"><p>{profile.displayName} has not published any themes yet.</p></div>
      )}
    </>
  );
}
