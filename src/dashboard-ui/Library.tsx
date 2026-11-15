import { useState } from 'react';
import { STATUS_LABEL, dashboardStatus, lastSuccess, type DashStatus } from '../dashboard/freshness';
import type { Dashboard } from '../dashboard/schema';
import { ago } from '../dashboard/util';
import { call, type Snapshot } from './data';
import { Dialog, Pill, hostOf } from './ui';

const TONE: Record<DashStatus, 'ok' | 'busy' | 'warn' | 'muted'> = { current: 'ok', updating: 'busy', paused: 'muted', attention: 'warn', empty: 'muted' };

/** A tiny picture of the dashboard's layout: one block per widget, as wide as it is. */
function LayoutPreview({ d }: { d: Dashboard }) {
  return (
    <div className="layout-preview" aria-hidden="true" style={{ ['--cols' as string]: d.columns }}>
      {d.widgets.slice(0, 9).map((w) => (
        <span key={w.id} className={`lp span-${Math.min(w.w, d.columns)} lp-${w.type}`} />
      ))}
      {!d.widgets.length && <span className="lp-empty">Empty</span>}
    </div>
  );
}

export function Library({ snap, open }: { snap: Snapshot; open: (id: string) => void }) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    }
  };
  const create = () => run(async () => open(((await call('create', { name: 'Untitled dashboard' })) as any).dashboard.id));

  return (
    <div className="library">
      <header className="lib-head">
        <div>
          <h1>Dashboards</h1>
          <p className="muted">Live pages built from the sources you approve. Everything stays in this browser.</p>
        </div>
        <label className="check">
          <input type="checkbox" checked={snap.globalPaused} onChange={(e) => run(() => call('setGlobalPaused', { paused: e.target.checked }))} /> Pause all background updates
        </label>
      </header>
      {error && <p className="error" role="alert">{error}</p>}
      {snap.ready && !snap.dashboards.length && (
        <div className="empty">
          <h2>No dashboards yet</h2>
          <p>Create one, then add widgets by hand or describe what you want to the assistant.</p>
        </div>
      )}
      <ul className="cards">
        <li>
          <button className="card new-card" onClick={create} aria-label="New dashboard">
            <span className="plus" aria-hidden="true">
              +
            </span>
            <strong>New dashboard</strong>
          </button>
        </li>
        {snap.dashboards.map((d) => {
          const status = dashboardStatus(d, snap.sources, snap.states, snap.globalPaused);
          const ids = [...new Set(d.widgets.flatMap((w) => (w.type === 'updates' ? w.sourceIds : w.type === 'list' || w.type === 'page-change' ? [w.sourceId] : [])))];
          const last = lastSuccess(d, snap.states);
          return (
            <li key={d.id}>
              <article className="card" aria-label={d.name}>
                <LayoutPreview d={d} />
                <div className="card-body">
                  <div className="card-top">
                    {renaming === d.id ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void run(async () => {
                            const cur = await chrome.storage.local.get(`dash:${d.id}`);
                            await call('save', { dashboard: { ...cur[`dash:${d.id}`], name } });
                            setRenaming(null);
                          });
                        }}
                      >
                        <input aria-label="Dashboard name" autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setRenaming(null)} />
                      </form>
                    ) : (
                      <h2>{d.name}</h2>
                    )}
                    <Pill tone={TONE[status]}>{STATUS_LABEL[status]}</Pill>
                  </div>
                  <p className="small muted">
                    {ids.length ? `Sources: ${ids.map((id) => snap.sources.get(id)?.name ?? hostOf(snap.sources.get(id)?.url ?? '')).filter(Boolean).slice(0, 3).join(', ')}${ids.length > 3 ? ` +${ids.length - 3}` : ''}` : 'No connected sources'}
                  </p>
                  <p className="small">{last ? `Last successful update ${ago(last)}` : ids.length ? 'No successful update yet' : 'Nothing to update'}</p>
                  <div className="row wrap">
                    <button className="primary" onClick={() => open(d.id)}>
                      Open
                    </button>
                    <button onClick={() => (setRenaming(d.id), setName(d.name))}>Rename</button>
                    <button onClick={() => run(() => call('duplicate', { id: d.id }))}>Duplicate</button>
                    <button onClick={() => run(() => call('setPaused', { id: d.id, paused: !d.paused }))}>{d.paused ? 'Resume' : 'Pause'}</button>
                    <button className="danger" onClick={() => setDeleting(d)}>
                      Delete
                    </button>
                  </div>
                </div>
              </article>
            </li>
          );
        })}
      </ul>
      {deleting && (
        <Dialog title={`Delete “${deleting.name}”?`} onClose={() => setDeleting(null)}>
          <p>This removes the dashboard and its widgets. Scheduled updates and saved data for sources that no other dashboard uses are removed too. Sources shared with another dashboard keep working.</p>
          <div className="actions">
            <button
              className="danger"
              onClick={() =>
                run(async () => {
                  await call('delete', { id: deleting.id });
                  setDeleting(null);
                })
              }
            >
              Delete dashboard
            </button>
            <button onClick={() => setDeleting(null)}>Cancel</button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
