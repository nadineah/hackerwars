import Link from 'next/link';
import type { Metadata } from 'next';
import { DeleteThemeForm, PreviewUpload, PublishForm, RemovePreview, VisibilityButtons } from '@/components/ThemeActions';
import ThemeForm, { scopeToForm } from '@/components/ThemeForm';
import { publishChecks, getOwnedThemeBySlug } from '@/lib/repo/themes';
import { db, extensionIds } from '@/lib/server';
import { requireUserOrRedirect } from '@/lib/session';

export const metadata: Metadata = { title: 'Edit theme', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function EditTheme({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUserOrRedirect(`/themes/${slug}/edit`);
  // Throws 404/403 for anyone who does not own it: drafts are never visible to other people.
  const t = getOwnedThemeBySlug(db(), user.id, slug);
  const version = t.draft ?? t.current;
  const checks = publishChecks(db(), user.id, t.id, true);
  const report = t.draft?.validationReport ?? { errors: [], warnings: [] };
  const hasChanges = !!t.draft;
  const isUpdate = t.status !== 'draft';
  void extensionIds;

  return (
    <div className="stack" style={{ gap: 28 }}>
      <div className="spread">
        <div>
          <p className="muted small" style={{ margin: 0 }}>
            <Link href="/library">My library</Link> / {t.title}
          </p>
          <h1 style={{ margin: '4px 0' }}>{t.title}</h1>
          <p className="muted" style={{ margin: 0 }}>
            <span className="badge">{t.status === 'draft' ? 'Draft' : t.status === 'published' ? `Published · v${t.version}` : t.unpublishedBy === 'moderation' ? 'Unpublished by a moderator' : 'Unpublished'}</span>{' '}
            {t.status === 'published' && <Link href={`/themes/${t.slug}`}>View public page</Link>}
          </p>
        </div>
        <VisibilityButtons themeId={t.id} status={t.status} byModerator={t.unpublishedBy === 'moderation'} />
      </div>

      {t.unpublishedBy === 'moderation' && (
        <div className="alert error" role="alert">
          A moderator unpublished this theme. It cannot be republished. Contact the site owner if you think this was a mistake.
        </div>
      )}

      <div className="two-col">
        <div className="stack" style={{ gap: 22 }}>
          <ThemeForm
            themeId={t.id}
            lockHostname
            initial={{
              title: t.title,
              hostname: t.hostname,
              description: t.description,
              tags: t.tags.join(', '),
              appearance: t.appearance,
              license: t.license,
              compatNotes: t.compatNotes,
              changeNotes: t.draft?.changeNotes ?? '',
              css: version?.css ?? '',
              ...(version ? scopeToForm(version.pathScope) : {}),
            }}
          />
        </div>

        <aside className="stack" style={{ gap: 18 }}>
          <section className="card-surface stack" aria-labelledby="validation">
            <h2 id="validation">CSS check</h2>
            {!t.draft ? (
              <p className="muted small">{t.current ? 'The published version passed validation. Edit the CSS and save to start a new version.' : 'Save the form to validate your CSS.'}</p>
            ) : report.errors.length === 0 ? (
              <div className="alert ok">The CSS passed validation{report.warnings.length ? ` with ${report.warnings.length} warning(s)` : ''}.</div>
            ) : (
              <div className="alert error" role="alert">
                <strong>{report.errors.length} problem(s) to fix:</strong>
                <ul>
                  {report.errors.map((e, i) => (
                    <li key={i}>
                      {e.line ? `Line ${e.line}: ` : ''}
                      {e.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {report.warnings.length > 0 && (
              <ul className="small muted">
                {report.warnings.map((w, i) => (
                  <li key={i}>
                    {w.line ? `Line ${w.line}: ` : ''}
                    {w.message}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card-surface stack" aria-labelledby="shots">
            <h2 id="shots">Screenshots</h2>
            {t.previews.length === 0 ? (
              <p className="muted small">At least one is required to publish.</p>
            ) : (
              <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
                {t.previews.map((p) => (
                  <li key={p.id} className="spread">
                    <span className="row">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/media/${p.mediaId}`} alt={p.alt || `${p.role} screenshot`} width={96} style={{ borderRadius: 8 }} />
                      <span className="small">{p.role === 'before' ? 'Before' : p.role === 'after' ? 'After' : 'Extra'}</span>
                    </span>
                    <RemovePreview themeId={t.id} previewId={p.id} label={p.role} />
                  </li>
                ))}
              </ul>
            )}
            <PreviewUpload themeId={t.id} siteName={t.siteName} />
          </section>

          {t.status !== 'unpublished' || t.unpublishedBy !== 'moderation' ? (
            <section className="card-surface stack" aria-labelledby="publish">
              <h2 id="publish">{isUpdate ? 'Publish changes' : 'Publish'}</h2>
              {isUpdate && !hasChanges ? <p className="muted small">There are no unpublished changes. Edit and save the form to prepare a new version.</p> : <PublishForm themeId={t.id} problems={checks.problems} isUpdate={isUpdate} />}
            </section>
          ) : null}

          {t.versions.length > 0 && (
            <section className="card-surface stack" aria-labelledby="versions">
              <h2 id="versions">Versions</h2>
              <ul className="small stack" style={{ listStyle: 'none', padding: 0 }}>
                {t.versions.map((v) => (
                  <li key={v.id}>
                    <strong>v{v.version}</strong> · {v.state}
                    {v.publishedAt ? ` · ${new Date(v.publishedAt).toISOString().slice(0, 10)}` : ''}
                    {v.changeNotes ? ` · ${v.changeNotes}` : ''}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="card-surface">
            <DeleteThemeForm themeId={t.id} />
          </section>
        </aside>
      </div>
    </div>
  );
}
