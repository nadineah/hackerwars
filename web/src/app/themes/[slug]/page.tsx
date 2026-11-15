import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import ApplyPanel from '@/components/ApplyPanel';
import ReportForm from '@/components/ReportForm';
import { toggleSaveAction } from '@/app/actions';
import { getProfile } from '@/lib/repo/accounts';
import { getPublishedThemeBySlug, isSavedBy } from '@/lib/repo/themes';
import { currentUser } from '@/lib/session';
import { db, extensionIds, siteUrl } from '@/lib/server';
import { LICENSES, describePathScope, supportedSite } from '../../../../../theme-core/src';

export const dynamic = 'force-dynamic';

type Params = { slug: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const t = getPublishedThemeBySlug(db(), slug);
  if (!t) return { title: 'Theme not found' };
  const first = t.previews.find((p) => p.role === 'after') ?? t.previews[0];
  return {
    title: `${t.title} for ${t.siteName}`,
    description: t.description || `A ${t.appearance} theme for ${t.siteName} by ${t.creator.displayName}.`,
    openGraph: { title: t.title, images: first ? [`${siteUrl()}/media/${first.mediaId}`] : undefined },
  };
}

export default async function ThemePage({ params, searchParams }: { params: Promise<Params>; searchParams: Promise<{ published?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const theme = getPublishedThemeBySlug(db(), slug);
  if (!theme || !theme.current) notFound();
  const user = await currentUser();
  const saved = user ? isSavedBy(db(), user.id, theme.id) : false;
  const creator = getProfile(db(), theme.creator.userId);
  const site = supportedSite(theme.hostname);
  const before = theme.previews.find((p) => p.role === 'before');
  const after = theme.previews.find((p) => p.role === 'after');
  const extras = theme.previews.filter((p) => p.role === 'extra');
  const license = LICENSES.find((l) => l.id === theme.license)?.label ?? theme.license;
  const isOwner = user?.id === theme.creator.userId;

  return (
    <>
      {sp.published && <div className="alert ok" role="status" style={{ marginBottom: 20 }}>Published! Share this page: <code>{siteUrl()}/themes/{theme.slug}</code></div>}
      <div className="detail-head">
        <div>
          <p className="muted small" style={{ margin: 0 }}><Link href="/explore">Themes</Link> / <Link href={`/explore?site=${theme.hostname}`}>{theme.siteName}</Link></p>
          <h1 style={{ margin: '6px 0' }}>{theme.title}</h1>
          <p className="muted" style={{ margin: 0 }}>
            by <Link href={`/creators/${theme.creator.username}`}>{theme.creator.displayName}</Link>
            {theme.creator.official && <span className="badge official" style={{ marginLeft: 8 }}>Official</span>}
          </p>
        </div>
        <div className="row">
          {isOwner && <Link className="btn secondary small" href={`/themes/${theme.slug}/edit`}>Edit</Link>}
          {user ? (
            <form action={toggleSaveAction.bind(null, theme.id, theme.slug, !saved)}>
              <button className="btn secondary small" type="submit" aria-pressed={saved}>{saved ? '✓ Saved' : 'Save'}</button>
            </form>
          ) : (
            <Link className="btn secondary small" href={`/sign-in?next=${encodeURIComponent(`/themes/${theme.slug}`)}`}>Sign in to save</Link>
          )}
        </div>
      </div>

      <div className="two-col">
        <div className="stack">
          {before || after ? (
            <section aria-label="Before and after">
              <div className="ba">
                {before && (
                  <figure>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/media/${before.mediaId}`} alt={before.alt || `${theme.siteName} before the theme`} />
                    <figcaption>Before</figcaption>
                  </figure>
                )}
                {after && (
                  <figure>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/media/${after.mediaId}`} alt={after.alt || `${theme.siteName} with the ${theme.title} theme`} />
                    <figcaption>After</figcaption>
                  </figure>
                )}
              </div>
            </section>
          ) : null}
          {extras.length > 0 && (
            <section aria-label="More screenshots" className="ba">
              {extras.map((e) => (
                <figure key={e.id}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/media/${e.mediaId}`} alt={e.alt || `More of the ${theme.title} theme`} loading="lazy" />
                </figure>
              ))}
            </section>
          )}

          {theme.description && <section><h2>About this theme</h2><p style={{ whiteSpace: 'pre-wrap' }}>{theme.description}</p></section>}

          <section>
            <h2>Compatibility</h2>
            <p>{site?.note ?? 'Applies to the website named below.'}</p>
            {theme.compatNotes && <p style={{ whiteSpace: 'pre-wrap' }}><strong>Creator notes:</strong> {theme.compatNotes}</p>}
            <p className="muted small">Themes change how a page looks; they cannot read your data. They never run on sign-in, security or payment pages.</p>
          </section>

          <section>
            <details className="source">
              <summary>View the CSS source</summary>
              <p className="small muted">This is exactly what the extension installs for version {theme.current.version}. It is CSS only (no scripts, no external files).</p>
              <pre className="css" tabIndex={0}><code>{theme.current.css}</code></pre>
            </details>
          </section>

          <section><ReportForm themeId={theme.id} /></section>
        </div>

        <aside className="stack">
          <ApplyPanel
            themeId={theme.id}
            versionId={theme.current.id}
            version={theme.current.version}
            slug={theme.slug}
            siteName={theme.siteName}
            hostname={theme.hostname}
            minExtensionVersion={theme.current.minExtensionVersion ?? undefined}
            extensionIds={extensionIds()}
          />
          <div className="card-surface">
            <h3>Details</h3>
            <dl className="facts">
              <dt>Website</dt><dd>{theme.siteName} <span className="muted small">({theme.hostname})</span></dd>
              <dt>Pages</dt><dd>{describePathScope(theme.current.pathScope)}</dd>
              <dt>Look</dt><dd>{theme.appearance === 'mixed' ? 'Light & dark' : theme.appearance === 'dark' ? 'Dark' : 'Light'}</dd>
              <dt>Version</dt><dd>{theme.current.version}{theme.current.publishedAt && <span className="muted small"> · {new Date(theme.current.publishedAt).toLocaleDateString()}</span>}</dd>
              <dt>License</dt><dd>{license}</dd>
              {theme.saveCount > 0 && (<><dt>Saved by</dt><dd>{theme.saveCount} {theme.saveCount === 1 ? 'person' : 'people'}</dd></>)}
              <dt>Integrity</dt><dd><code title={theme.current.hash}>{theme.current.hash.slice(0, 12)}…</code></dd>
            </dl>
            {theme.tags.length > 0 && <div className="chips" style={{ marginTop: 12 }}>{theme.tags.map((t) => <Link key={t} className="badge" href={`/explore?tag=${encodeURIComponent(t)}`}>{t}</Link>)}</div>}
            {theme.current.changeNotes && <p className="small" style={{ marginTop: 12 }}><strong>What is new:</strong> {theme.current.changeNotes}</p>}
          </div>
          {creator?.bio && <p className="muted small">{creator.bio}</p>}
        </aside>
      </div>
    </>
  );
}
