import { useState } from 'react';
import { freshness } from '../dashboard/freshness';
import { combine, sortRecords } from '../dashboard/records';
import { LIMITS, approvalCovers, type DashRecord, type LinksWidget, type ListWidget, type NotesWidget, type PageChangeWidget, type Source, type UpdatesWidget, type Widget } from '../dashboard/schema';
import { ago, safeLink } from '../dashboard/util';
import type { Snapshot } from './data';
import { Dialog, Field, Pill, hostOf } from './ui';

const Safe = ({ href, children }: { href?: string; children: React.ReactNode }) => {
  const url = href ? safeLink(href, 'https://invalid.example/') : undefined;
  // Text from the web is rendered as text by React, and links are plain http(s) only.
  return url ? (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <>{children}</>
  );
};

function Item({ r, showSource, showSummary, showImage, showTime }: { r: DashRecord; showSource?: boolean; showSummary?: boolean; showImage?: boolean; showTime?: boolean }) {
  return (
    <li className="item">
      {showImage && r.image && <img src={r.image} alt="" loading="lazy" referrerPolicy="no-referrer" className="thumb" />}
      <div>
        <Safe href={r.url}>{r.title}</Safe>
        <div className="small muted">
          {showSource && <span>{r.sourceName}</span>}
          {showTime !== false && (r.publishedAt ? <span>{showSource ? ' · ' : ''}{ago(r.publishedAt)}</span> : <span>{showSource ? ' · ' : ''}first seen {ago(r.collectedAt)}</span>)}
        </div>
        {showSummary && r.summary && <div className="summary">{r.summary}</div>}
      </div>
    </li>
  );
}

function SourceStatusLine({ snap, ids }: { snap: Snapshot; ids: string[] }) {
  const lines = ids
    .map((id) => snap.sources.get(id))
    .filter((s): s is Source => !!s)
    .map((s) => ({ s, f: freshness(s, snap.states.get(s.id), Date.now(), snap.globalPaused) }));
  if (!lines.length) return <p className="notice">The source for this widget was removed. Open Sources to add one.</p>;
  return (
    <div className="status-lines" aria-live="polite">
      {lines.map(({ s, f }) => (
        <div key={s.id} className="small">
          <Pill tone={f.tone}>{f.label}</Pill> <span className="muted">{lines.length > 1 ? s.name : ''}</span>
          {f.tone === 'warn' && f.detail && <div className="muted">{f.detail}</div>}
        </div>
      ))}
    </div>
  );
}

function UpdatesBody({ w, snap }: { w: UpdatesWidget; snap: Snapshot }) {
  const items = combine(w.sourceIds.map((id) => snap.records.get(id) ?? []), { keyword: w.keyword, sort: w.sort, limit: w.limit });
  return (
    <>
      {w.showChecked && <SourceStatusLine snap={snap} ids={w.sourceIds} />}
      {items.length ? (
        <ul className="items">
          {items.map((r) => (
            <Item key={r.id} r={r} showSource showSummary={false} />
          ))}
        </ul>
      ) : (
        <p className="muted">{w.keyword ? `Nothing matches “${w.keyword}” yet.` : 'No items yet.'}</p>
      )}
    </>
  );
}

function ListBody({ w, snap }: { w: ListWidget; snap: Snapshot }) {
  const items = sortRecords(snap.records.get(w.sourceId) ?? []).slice(0, w.limit);
  return (
    <>
      <SourceStatusLine snap={snap} ids={[w.sourceId]} />
      {items.length ? (
        <ul className="items">
          {items.map((r) => (
            <Item key={r.id} r={r} showSummary={w.showSummary} showImage={w.showImage} showTime={w.showTime} />
          ))}
        </ul>
      ) : (
        <p className="muted">No items yet.</p>
      )}
    </>
  );
}

function PageChangeBody({ w, snap }: { w: PageChangeWidget; snap: Snapshot }) {
  const st = snap.states.get(w.sourceId);
  const src = snap.sources.get(w.sourceId);
  return (
    <>
      <SourceStatusLine snap={snap} ids={[w.sourceId]} />
      {st?.watchText === undefined ? (
        <p className="muted">Waiting for the first reading.</p>
      ) : (
        <>
          <p className="watch">{st.watchText}</p>
          {st.previousWatchText !== undefined && st.lastChangeAt ? (
            <p className="small">
              <strong>Changed {ago(st.lastChangeAt)}.</strong> Before: <span className="muted">{st.previousWatchText}</span>
            </p>
          ) : (
            <p className="small muted">No change seen yet.</p>
          )}
        </>
      )}
      {src && <p className="small muted">Watching {hostOf(src.url)}</p>}
    </>
  );
}

function LinksBody({ w, editing, onChange }: { w: LinksWidget; editing: boolean; onChange: (w: Widget) => void }) {
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [err, setErr] = useState('');
  const add = () => {
    try {
      const u = new URL(url.trim().includes('://') ? url.trim() : `https://${url.trim()}`);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
      if (w.links.length >= LIMITS.links) return setErr('That is the most links this widget can hold.');
      onChange({ ...w, links: [...w.links, { id: `l_${Math.random().toString(36).slice(2, 10)}`, title: title.trim() || u.hostname, url: u.toString() }] });
      setTitle('');
      setUrl('');
      setErr('');
    } catch {
      setErr('Enter a web address starting with http:// or https://');
    }
  };
  return (
    <>
      {!w.links.length && <p className="muted">No saved links yet.</p>}
      <ul className="items">
        {w.links.map((l) => (
          <li key={l.id} className="item">
            <Safe href={l.url}>{l.title}</Safe>
            <span className="small muted"> {hostOf(l.url)}</span>
            {editing && (
              <button className="icon" aria-label={`Remove link ${l.title}`} onClick={() => onChange({ ...w, links: w.links.filter((x) => x.id !== l.id) })}>
                ✕
              </button>
            )}
          </li>
        ))}
      </ul>
      {editing && (
        <div className="row wrap">
          <input aria-label="Link title" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <input aria-label="Link address" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <button onClick={add}>Add link</button>
          {err && <span className="error" role="alert">{err}</span>}
        </div>
      )}
      <p className="small muted">Saved only in this browser. These links do not update by themselves.</p>
    </>
  );
}

function NotesBody({ w, editing, onChange }: { w: NotesWidget; editing: boolean; onChange: (w: Widget) => void }) {
  return editing ? (
    <textarea aria-label={`${w.title} text`} className="notes" value={w.text} maxLength={LIMITS.notesChars} onChange={(e) => onChange({ ...w, text: e.target.value })} placeholder="Write anything. It saves automatically and stays in this browser." />
  ) : (
    <p className="notes-view">{w.text || <span className="muted">Empty note.</span>}</p>
  );
}

export function WidgetCard({ w, snap, editing, index, count, onChange, onMove, onRemove, onSettings }: { w: Widget; snap: Snapshot; editing: boolean; index: number; count: number; onChange: (w: Widget) => void; onMove: (dir: -1 | 1) => void; onRemove: () => void; onSettings: () => void }) {
  const auto = w.type === 'updates' || w.type === 'list' || w.type === 'page-change';
  return (
    <section className={`widget span-${w.w}${w.paused ? ' is-paused' : ''}`} aria-label={w.title}>
      <header className="widget-head">
        <h3>{w.title}</h3>
        {w.paused && <Pill tone="muted">Paused</Pill>}
        {!auto && <span className="tag">Local</span>}
        {editing && (
          <div className="widget-tools">
            <button className="icon" aria-label={`Move ${w.title} earlier`} disabled={index === 0} onClick={() => onMove(-1)}>
              ←
            </button>
            <button className="icon" aria-label={`Move ${w.title} later`} disabled={index === count - 1} onClick={() => onMove(1)}>
              →
            </button>
            <button className="icon" aria-label={`Settings for ${w.title}`} onClick={onSettings}>
              ⚙
            </button>
            <button className="icon" aria-label={`Remove ${w.title}`} onClick={onRemove}>
              ✕
            </button>
          </div>
        )}
      </header>
      {w.type === 'updates' && <UpdatesBody w={w} snap={snap} />}
      {w.type === 'list' && <ListBody w={w} snap={snap} />}
      {w.type === 'page-change' && <PageChangeBody w={w} snap={snap} />}
      {w.type === 'links' && <LinksBody w={w} editing={editing} onChange={onChange} />}
      {w.type === 'notes' && <NotesBody w={w} editing={editing} onChange={onChange} />}
    </section>
  );
}

// ------------------------------------------------------------------------------------------ widget settings

export function WidgetSettings({ w, snap, onSave, onClose, onAddSource }: { w: Widget; snap: Snapshot; onSave: (w: Widget) => void; onClose: () => void; onAddSource: () => void }) {
  const [d, setD] = useState<Widget>(w);
  const sources = [...snap.sources.values()];
  const set = (patch: Record<string, unknown>) => setD((x) => ({ ...x, ...patch }) as Widget);
  return (
    <Dialog title={`Settings: ${w.title}`} onClose={onClose}>
      <div className="form">
        <Field label="Title">
          <input value={d.title} maxLength={LIMITS.titleChars} onChange={(e) => set({ title: e.target.value })} />
        </Field>
        <Field label="Width">
          <select value={d.w} onChange={(e) => set({ w: Number(e.target.value) })}>
            <option value={1}>1 column</option>
            <option value={2}>2 columns</option>
            <option value={3}>3 columns</option>
          </select>
        </Field>
        {d.type === 'updates' && (
          <>
            <fieldset>
              <legend>Sources to combine</legend>
              {sources.map((s) => (
                <label key={s.id} className="check">
                  <input type="checkbox" checked={d.sourceIds.includes(s.id)} onChange={(e) => set({ sourceIds: e.target.checked ? [...d.sourceIds, s.id].slice(0, LIMITS.sourcesPerWidget) : d.sourceIds.filter((x) => x !== s.id) })} /> {s.name}
                  {!approvalCovers(s.approval, s) && <span className="muted small"> (needs approval)</span>}
                </label>
              ))}
              {!sources.length && <p className="muted">No sources yet.</p>}
              <button onClick={onAddSource}>+ Add source</button>
            </fieldset>
            <div className="row">
              <Field label="Items shown">
                <input type="number" min={1} max={LIMITS.maxItems} value={d.limit} onChange={(e) => set({ limit: Number(e.target.value) })} />
              </Field>
              <Field label="Sort by">
                <select value={d.sort} onChange={(e) => set({ sort: e.target.value })}>
                  <option value="published">Published time (when the source gives one)</option>
                  <option value="collected">When first seen</option>
                </select>
              </Field>
            </div>
            <Field label="Only items containing (optional)">
              <input value={d.keyword ?? ''} maxLength={LIMITS.keywordChars} onChange={(e) => set({ keyword: e.target.value })} />
            </Field>
            <label className="check">
              <input type="checkbox" checked={d.showChecked} onChange={(e) => set({ showChecked: e.target.checked })} /> Show when each source was last checked
            </label>
          </>
        )}
        {(d.type === 'list' || d.type === 'page-change') && (
          <Field label="Source">
            <select value={d.sourceId} onChange={(e) => set({ sourceId: e.target.value })}>
              <option value="">Choose…</option>
              {sources
                .filter((s) => (d.type === 'page-change' ? s.kind === 'page-change' : s.kind !== 'page-change'))
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </Field>
        )}
        {d.type === 'list' && (
          <>
            <Field label="Items shown">
              <input type="number" min={1} max={LIMITS.maxItems} value={d.limit} onChange={(e) => set({ limit: Number(e.target.value) })} />
            </Field>
            <label className="check">
              <input type="checkbox" checked={d.showSummary} onChange={(e) => set({ showSummary: e.target.checked })} /> Show summaries
            </label>
            <label className="check">
              <input type="checkbox" checked={d.showImage} onChange={(e) => set({ showImage: e.target.checked })} /> Show images (loaded from the source site)
            </label>
            <label className="check">
              <input type="checkbox" checked={d.showTime} onChange={(e) => set({ showTime: e.target.checked })} /> Show times
            </label>
          </>
        )}
        {(d.type === 'updates' || d.type === 'list' || d.type === 'page-change') && (
          <label className="check">
            <input type="checkbox" checked={!!d.paused} onChange={(e) => set({ paused: e.target.checked || undefined })} /> Pause updates for this widget (its sources are not refreshed on its account)
          </label>
        )}
      </div>
      <div className="actions">
        <button className="primary" onClick={() => onSave(d)}>
          Save
        </button>
        <button onClick={onClose}>Cancel</button>
      </div>
    </Dialog>
  );
}

export const WIDGET_TYPES: { type: Widget['type']; label: string; blurb: string; needsSource: boolean }[] = [
  { type: 'updates', label: 'Combined updates', blurb: 'The newest items from one or more sources, merged.', needsSource: true },
  { type: 'list', label: 'Single-source list', blurb: 'The items from one source.', needsSource: true },
  { type: 'page-change', label: 'Page change', blurb: 'Tells you when part of a page changes.', needsSource: true },
  { type: 'links', label: 'Saved links', blurb: 'Your own bookmarks. Stored locally.', needsSource: false },
  { type: 'notes', label: 'Notes', blurb: 'Free-text notes that autosave locally.', needsSource: false },
];

export function blankWidget(type: Widget['type'], sourceIds: string[]): Widget {
  const id = `w_${Math.random().toString(36).slice(2, 12)}`;
  switch (type) {
    case 'updates':
      return { id, type, title: 'Latest updates', w: 2, sourceIds, sort: 'published', limit: 15, showChecked: true };
    case 'list':
      return { id, type, title: 'List', w: 1, sourceId: sourceIds[0] ?? '', limit: 10, showSummary: true, showImage: false, showTime: true };
    case 'page-change':
      return { id, type, title: 'Page watcher', w: 1, sourceId: sourceIds[0] ?? '' };
    case 'links':
      return { id, type, title: 'Saved links', w: 1, links: [] };
    case 'notes':
      return { id, type, title: 'Notes', w: 1, text: '' };
  }
}
