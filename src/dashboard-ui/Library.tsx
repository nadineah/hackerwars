import { useState } from 'react';
import { STATUS_LABEL, cardStatus, type CardStatus } from '../dashboard/freshness';
import type { Dashboard } from '../dashboard/schema';
import { ago } from '../dashboard/util';
import { call, type Snapshot } from './data';
import { Dialog, Pill } from './ui';

const TONE: Record<CardStatus, 'ok' | 'busy' | 'warn' | 'muted'> = { current: 'ok', updating: 'busy', paused: 'muted', attention: 'warn', static: 'muted', empty: 'muted' };

/** A small, inert sketch of the page: the first lines of its text, so a card says something about the dashboard. */
function snippet(d: Dashboard): string {
  const text = d.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, 90);
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
          <p className="muted">Pages the assistant builds for you, kept up to date from the websites you approve. Everything stays in this browser.</p>
        </div>
        <label className="check">
          <input type="checkbox" checked={snap.globalPaused} onChange={(e) => run(() => call('setGlobalPaused', { paused: e.target.checked }))} /> Pause all background updates
        </label>
      </header>
      {error && <p className="error" role="alert">{error}</p>}
      {snap.ready && !snap.dashboards.length && (
        <div className="empty">
          <h2>No dashboards yet</h2>
          <p>Create one, then describe it to the assistant.</p>
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
          const st = snap.states.get(d.id);
          const status = cardStatus(d, st, snap.globalPaused);
          return (
            <li key={d.id}>
              <article className="card" aria-label={d.name}>
                <div className="card-sketch" aria-hidden="true">
                  <span>{snippet(d) || 'Empty dashboard'}</span>
                </div>
                <div className="card-body">
                  <div className="card-top">
                    {renaming === d.id ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void run(async () => {
                            await call('save', { dashboard: { ...d, name } });
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
                  <p className="small muted">{d.domains.length ? `Reads: ${d.domains.slice(0, 3).join(', ')}${d.domains.length > 3 ? ` +${d.domains.length - 3}` : ''}` : 'Reads no websites'}</p>
                  <p className="small">{st?.lastSuccessAt ? `Last successful update ${ago(st.lastSuccessAt)}` : d.collect.trim() ? 'No successful update yet' : 'Nothing to update'}</p>
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
          <p>This removes the dashboard, its scheduled updates, the data it collected, and its notes and chat. It cannot be undone.</p>
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
