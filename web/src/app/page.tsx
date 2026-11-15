import Link from 'next/link';
import ThemeCard from '@/components/ThemeCard';
import { listFeatured, listPublishedThemes } from '@/lib/repo/themes';
import { db } from '@/lib/server';
import { SUPPORTED_SITES } from '../../../theme-core/src';

export const dynamic = 'force-dynamic';

export default async function Home({ searchParams }: { searchParams: Promise<{ deleted?: string }> }) {
  const sp = await searchParams;
  const featured = listFeatured(db(), 6);
  const total = listPublishedThemes(db(), { pageSize: 1 }).total;
  return (
    <>
      {sp.deleted && <div className="alert ok" role="status">Your account and everything you published has been deleted.</div>}
      <section className="hero">
        <h1>Make the internet yours.</h1>
        <p className="lead">
          WhimsyWeb is a library of themes for the websites you already use. Find one you love, preview it, and apply it with the
          browser extension. Or make your own and share it.
        </p>
        <div className="actions">
          <Link className="btn" href="/explore">Explore themes</Link>
          <Link className="btn secondary" href="/install">Get the extension</Link>
        </div>
        <ol className="steps">
          <li><strong>Discover</strong>Browse themes by website and look.</li>
          <li><strong>Preview</strong>See before-and-after screenshots and read the CSS.</li>
          <li><strong>Apply</strong>The extension asks you to confirm, then restyles the site. Undo any time.</li>
          <li><strong>Share</strong>Publish your own theme for everyone.</li>
        </ol>
      </section>

      <section aria-labelledby="featured">
        <div className="row spread" style={{ marginBottom: 16 }}>
          <h2 id="featured" style={{ margin: 0 }}>{featured.length > 0 ? 'Popular themes' : 'Themes'}</h2>
          {total > 0 && <Link href="/explore">See all {total}</Link>}
        </div>
        {featured.length > 0 ? (
          <div className="grid">{featured.map((t) => <ThemeCard key={t.id} theme={t} />)}</div>
        ) : (
          <div className="empty">
            <h2>No themes yet</h2>
            <p>Be the first to publish one.</p>
            <Link className="btn" href="/publish">Publish a theme</Link>
          </div>
        )}
      </section>

      <section style={{ marginTop: 56 }} aria-labelledby="sites">
        <h2 id="sites">Supported websites</h2>
        <p className="muted">Themes can target these sites today. Each theme names exactly one.</p>
        <div className="chips">
          {SUPPORTED_SITES.map((s) => (
            <Link key={s.hostname} href={`/explore?site=${encodeURIComponent(s.hostname)}`} className="badge">{s.name}</Link>
          ))}
        </div>
      </section>
    </>
  );
}
