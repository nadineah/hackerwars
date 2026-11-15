import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { moderatorUnpublishAction, resolveReportAction } from '@/app/actions';
import { listModerationLog, listReports } from '@/lib/repo/moderation';
import { db } from '@/lib/server';
import { currentUser } from '@/lib/session';
import { REPORT_REASONS } from '@/lib/validation';

export const metadata: Metadata = { title: 'Moderation', robots: { index: false } };
export const dynamic = 'force-dynamic';

const when = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

export default async function Moderation({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await currentUser();
  // Do not reveal that this area exists to anyone else.
  if (!user || user.role !== 'moderator') notFound();
  const sp = await searchParams;
  const status = sp.status === 'actioned' || sp.status === 'dismissed' || sp.status === 'all' ? sp.status : 'open';
  const reports = listReports(db(), user.id, status);
  const log = listModerationLog(db(), user.id, 50);
  const reason = (id: string) => REPORT_REASONS.find((r) => r.id === id)?.label ?? id;

  return (
    <div className="stack" style={{ gap: 24 }}>
      <h1>Moderation</h1>
      <nav className="row" aria-label="Report status">
        {(['open', 'actioned', 'dismissed', 'all'] as const).map((s) => (
          <Link key={s} className={status === s ? 'btn small' : 'btn secondary small'} href={`/moderation?status=${s}`} aria-current={status === s ? 'page' : undefined}>
            {s[0].toUpperCase() + s.slice(1)}
          </Link>
        ))}
      </nav>
      {reports.length === 0 ? (
        <div className="empty">No {status === 'all' ? '' : status} reports.</div>
      ) : (
        <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
          {reports.map((r) => (
            <li key={r.id} className="card-surface stack">
              <div className="spread">
                <div>
                  <strong>{r.themeTitle}</strong> <span className="muted small">by {r.ownerUsername} · {r.themeStatus}</span>
                  <div className="muted small">
                    {reason(r.reason)} · {when(r.createdAt)} · reported by {r.reporter ?? 'a visitor'}
                  </div>
                </div>
                {r.themeStatus === 'published' && (
                  <Link className="btn secondary small" href={`/themes/${r.themeSlug}`}>
                    View theme
                  </Link>
                )}
              </div>
              {r.detail && <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{r.detail}</p>}
              {r.status === 'open' ? (
                <form action={resolveReportAction} className="stack">
                  <input type="hidden" name="reportId" value={r.id} />
                  <div className="field">
                    <label htmlFor={`note-${r.id}`}>Note (kept in the audit log)</label>
                    <input id={`note-${r.id}`} name="note" maxLength={300} />
                  </div>
                  <div className="row">
                    <button className="btn danger small" name="action" value="unpublish">
                      Unpublish theme
                    </button>
                    <button className="btn secondary small" name="action" value="dismiss">
                      Dismiss report
                    </button>
                  </div>
                </form>
              ) : (
                <p className="muted small" style={{ margin: 0 }}>
                  {r.status === 'actioned' ? 'Actioned' : 'Dismissed'} {r.resolvedAt ? when(r.resolvedAt) : ''}
                  {r.resolutionNote ? `: ${r.resolutionNote}` : ''}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <section aria-labelledby="log">
        <h2 id="log">Audit log</h2>
        <div className="table-wrap">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th align="left">When</th>
                <th align="left">Who</th>
                <th align="left">Action</th>
                <th align="left">Theme</th>
                <th align="left">Note</th>
              </tr>
            </thead>
            <tbody>
              {log.map((l) => (
                <tr key={l.id}>
                  <td>{when(l.createdAt)}</td>
                  <td>{l.actor ?? 'system'}</td>
                  <td>{l.action}</td>
                  <td>{l.themeTitle ?? '(deleted)'}</td>
                  <td>{l.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form action={moderatorUnpublishAction} className="row" style={{ marginTop: 16 }}>
          <label className="visually-hidden" htmlFor="direct-id">
            Theme id to unpublish
          </label>
          <input id="direct-id" name="themeId" placeholder="Theme id (direct unpublish)" required />
          <input name="note" placeholder="Reason" aria-label="Reason" maxLength={300} />
          <button className="btn danger small">Unpublish</button>
        </form>
      </section>
    </div>
  );
}
