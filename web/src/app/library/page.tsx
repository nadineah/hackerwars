import Link from 'next/link';
import type { Metadata } from 'next';
import { toggleSaveAction } from '@/app/actions';
import InstalledBadge from '@/components/InstalledBadge';
import ThemeCard from '@/components/ThemeCard';
import { listOwnThemes, listSaved, type ThemeCard as Card } from '@/lib/repo/themes';
import { db, extensionIds } from '@/lib/server';
import { requireUserOrRedirect } from '@/lib/session';

export const metadata: Metadata = { title: 'My library' };
export const dynamic = 'force-dynamic';

function Row({ t, ids, actions }: { t: Card; ids: string[]; actions: React.ReactNode }) {
  return (
    <li className="card-surface spread" style={{ padding: 14 }}>
      <div>
        <strong>{t.title}</strong> <span className="muted small">· {t.siteName}</span>
        <div className="row small muted" style={{ marginTop: 4 }}>
          <span className="badge">{t.status === 'draft' ? 'Draft' : t.status === 'published' ? `Published${t.version ? ` · v${t.version}` : ''}` : 'Unpublished'}</span>
          <InstalledBadge themeId={t.id} currentVersion={t.version} extensionIds={ids} />
        </div>
      </div>
      <div className="row">{actions}</div>
    </li>
  );
}

export default async function Library({ searchParams }: { searchParams: Promise<{ deleted?: string }> }) {
  const user = await requireUserOrRedirect('/library');
  const sp = await searchParams;
  const saved = listSaved(db(), user.id);
  const own = listOwnThemes(db(), user.id);
  const drafts = own.filter((t) => t.status === 'draft');
  const published = own.filter((t) => t.status !== 'draft');
  const ids = extensionIds();

  return (
    <div className="stack" style={{ gap: 28 }}>
      <div className="spread">
        <h1 style={{ margin: 0 }}>My library</h1>
        <Link className="btn" href="/publish">
          Publish a theme
        </Link>
      </div>
      {sp.deleted && (
        <div className="alert ok" role="status">
          Theme deleted.
        </div>
      )}

      <section aria-labelledby="saved">
        <h2 id="saved">Saved themes</h2>
        <p className="muted small">Saving a theme keeps it in your collection. It is not the same as installing it: use Apply theme on its page to install it in your browser.</p>
        {saved.length === 0 ? (
          <div className="empty">
            <p>Nothing saved yet.</p>
            <Link className="btn secondary" href="/explore">
              Explore themes
            </Link>
          </div>
        ) : (
          <ul className="grid" style={{ listStyle: 'none', padding: 0 }}>
            {saved.map((t) => (
              <li key={t.id} className="stack" style={{ gap: 8 }}>
                <ThemeCard theme={t} />
                <div className="row">
                  <InstalledBadge themeId={t.id} currentVersion={t.version} extensionIds={ids} />
                  <form action={toggleSaveAction.bind(null, t.id, t.slug, false)}>
                    <button className="btn secondary small" type="submit">
                      Remove from saved
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="published">
        <h2 id="published">My published themes</h2>
        {published.length === 0 ? (
          <p className="muted">You have not published a theme yet.</p>
        ) : (
          <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
            {published.map((t) => (
              <Row
                key={t.id}
                t={t}
                ids={ids}
                actions={
                  <>
                    {t.status === 'published' && (
                      <Link className="btn secondary small" href={`/themes/${t.slug}`}>
                        View
                      </Link>
                    )}
                    <Link className="btn secondary small" href={`/themes/${t.slug}/edit`}>
                      Manage
                    </Link>
                  </>
                }
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="drafts">
        <h2 id="drafts">Drafts</h2>
        <p className="muted small">Only you can see drafts.</p>
        {drafts.length === 0 ? (
          <p className="muted">No drafts.</p>
        ) : (
          <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
            {drafts.map((t) => (
              <Row
                key={t.id}
                t={t}
                ids={ids}
                actions={
                  <Link className="btn small" href={`/themes/${t.slug}/edit`}>
                    Continue editing
                  </Link>
                }
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
