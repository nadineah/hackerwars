import { useState } from 'react';
import { freshness } from '../dashboard/freshness';
import { KINDS, effectiveInfo, validateSourceInput, type Approval, type FieldAttr, type Source, type SourceKind, type SourceState } from '../dashboard/schema';
import { call, type Snapshot } from './data';
import { Dialog, Field, Pill, hostOf } from './ui';

// ------------------------------------------------------------------------------------------ approval

/** Plain-language summary of what a source collects, derived from its validated config. */
export function describeCollection(src: Pick<Source, 'kind' | 'config'>): string {
  const c = src.config as any;
  switch (src.kind) {
    case 'feed':
      return `The titles, links, short summaries, images and publish dates of up to ${c.maxItems} entries.`;
    case 'json':
      return `The fields you mapped (${Object.keys(c.fields).join(', ')}) of up to ${c.maxItems} items.`;
    case 'html':
    case 'rendered':
      return `Text and links matched by the selector "${c.itemSelector}" (${Object.keys(c.fields).join(', ')}), up to ${c.maxItems} items. Nothing else on the page is read.`;
    case 'page-change':
      return `The text inside "${c.selector}", to tell you when it changes.`;
  }
}

export function ApprovalDialog({ src, existing, onDone, onCancel }: { src: Source; existing?: Approval | null; onDone: () => void; onCancel: () => void }) {
  const info = effectiveInfo(src.kind, src.config);
  const [interval, setIntervalMin] = useState(src.intervalMinutes);
  const [bg, setBg] = useState(src.backgroundTabs);
  const [editInterval, setEditInterval] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const check = validateSourceInput({ kind: src.kind, url: src.url, config: src.config, intervalMinutes: interval, backgroundTabs: bg });
  const rendered = info.method === 'rendered';
  const intervalError = check.ok ? '' : check.errors.find((e) => e.startsWith('intervalMinutes'))?.replace('intervalMinutes: ', '') ?? '';
  const allow = async () => {
    setBusy(true);
    try {
      await call('approve', { sourceId: src.id, intervalMinutes: interval, backgroundTabs: rendered ? bg : false });
      onDone();
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <Dialog title={existing ? 'Approve changed access' : 'Allow automatic updates?'} onClose={onCancel}>
      {existing && <p className="notice">This source now needs more access than you approved before (a new site, method or background tab). Please review it.</p>}
      <dl className="facts">
        <dt>Site</dt>
        <dd>
          <strong>{hostOf(src.url)}</strong>
          <br />
          <span className="mono small">{src.url}</span>
        </dd>
        <dt>What is collected</dt>
        <dd>{describeCollection(src)}</dd>
        <dt>How</dt>
        <dd>{info.summary}</dd>
        <dt>How often</dt>
        <dd>
          Every {interval} minutes{' '}
          <button className="link" onClick={() => setEditInterval((v) => !v)} aria-expanded={editInterval}>
            Change interval
          </button>
          {editInterval && (
            <div className="row">
              <input type="number" aria-label="Minutes between updates" value={interval} min={info.minIntervalMin} max={info.maxIntervalMin} onChange={(e) => setIntervalMin(Number(e.target.value))} />
              <span className="hint">minutes (at least {info.minIntervalMin})</span>
            </div>
          )}
          {intervalError && <div className="error">{intervalError}</div>}
        </dd>
        {rendered && (
          <>
            <dt>Background tabs</dt>
            <dd>
              <label className="check">
                <input type="checkbox" checked={bg} onChange={(e) => setBg(e.target.checked)} /> Allow WhimsyWeb to open this page in an inactive background tab, read it, and close that tab.
              </label>
              <span className="hint">If you already have this page open, that tab is used instead and is never changed or closed. Without this, the source only updates while you have the page open.</span>
            </dd>
          </>
        )}
        <dt>Where the data goes</dt>
        <dd>It stays in this browser. It is not sent to any AI unless you ask the assistant about it.</dd>
        <dt>Sign-in</dt>
        <dd>{rendered ? 'Uses your existing sign-in in this browser. WhimsyWeb never sees or stores your password.' : 'No cookies or sign-in are used.'}</dd>
      </dl>
      <p className="hint">Updates run only while the browser is running, and may be skipped if it is closed.</p>
      {error && <div className="error">{error}</div>}
      <div className="actions">
        <button className="primary" disabled={busy || !check.ok} onClick={allow}>
          Allow automatic updates
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------------ add / edit a source

interface Form {
  kind: SourceKind;
  name: string;
  url: string;
  interval: string;
  backgroundTabs: boolean;
  maxItems: number;
  itemSelector: string;
  titleSel: string;
  linkSel: string;
  summarySel: string;
  dateSel: string;
  dateAttr: FieldAttr;
  imageSel: string;
  waitFor: string;
  itemsPath: string;
  fTitle: string;
  fUrl: string;
  fSummary: string;
  fPublished: string;
  urlTemplate: string;
  watchSel: string;
  via: 'fetch' | 'rendered';
}

const BLANK: Form = { kind: 'feed', name: '', url: '', interval: '', backgroundTabs: false, maxItems: 15, itemSelector: '', titleSel: '', linkSel: 'a', summarySel: '', dateSel: '', dateAttr: 'datetime', imageSel: '', waitFor: '', itemsPath: '', fTitle: 'title', fUrl: 'url', fSummary: '', fPublished: '', urlTemplate: '', watchSel: '', via: 'fetch' };

const spec = (selector: string, attr?: FieldAttr) => (selector.trim() || attr ? { ...(selector.trim() ? { selector: selector.trim() } : {}), ...(attr ? { attr } : {}) } : undefined);

export function toInput(f: Form) {
  const optional = (v: string) => (v.trim() ? v.trim() : undefined);
  let config: unknown;
  if (f.kind === 'feed') config = { maxItems: f.maxItems };
  else if (f.kind === 'json') config = { itemsPath: f.itemsPath.trim(), maxItems: f.maxItems, urlTemplate: optional(f.urlTemplate), fields: { title: f.fTitle.trim(), url: optional(f.fUrl), summary: optional(f.fSummary), published: optional(f.fPublished) } };
  else if (f.kind === 'page-change') config = { selector: f.watchSel.trim(), via: f.via };
  else
    config = {
      itemSelector: f.itemSelector.trim(),
      maxItems: f.maxItems,
      waitFor: optional(f.waitFor),
      fields: { title: spec(f.titleSel) ?? {}, url: spec(f.linkSel, 'href'), summary: spec(f.summarySel), published: f.dateSel.trim() ? spec(f.dateSel, f.dateAttr) : undefined, image: f.imageSel.trim() ? spec(f.imageSel, 'src') : undefined },
    };
  return { kind: f.kind, name: f.name, url: f.url.trim(), config, intervalMinutes: f.interval ? Number(f.interval) : undefined, backgroundTabs: f.backgroundTabs || (f.kind === 'page-change' && f.via === 'rendered' && f.backgroundTabs) };
}

export function formFrom(src: Source): Form {
  const c = src.config as any;
  const base: Form = { ...BLANK, kind: src.kind, name: src.name, url: src.url, interval: String(src.intervalMinutes), backgroundTabs: src.backgroundTabs, maxItems: c.maxItems ?? 15 };
  if (src.kind === 'json') Object.assign(base, { itemsPath: c.itemsPath, fTitle: c.fields.title, fUrl: c.fields.url ?? '', fSummary: c.fields.summary ?? '', fPublished: c.fields.published ?? '', urlTemplate: c.urlTemplate ?? '' });
  if (src.kind === 'html' || src.kind === 'rendered') Object.assign(base, { itemSelector: c.itemSelector, titleSel: c.fields.title.selector ?? '', linkSel: c.fields.url?.selector ?? 'a', summarySel: c.fields.summary?.selector ?? '', dateSel: c.fields.published?.selector ?? '', dateAttr: c.fields.published?.attr ?? 'datetime', imageSel: c.fields.image?.selector ?? '', waitFor: c.waitFor ?? '' });
  if (src.kind === 'page-change') Object.assign(base, { watchSel: c.selector, via: c.via });
  return base;
}

export function SourceForm({ initial, existing, onSaved, onCancel }: { initial?: Source; existing?: boolean; onSaved: (src: Source, needsApproval: boolean) => void; onCancel: () => void }) {
  const [f, setF] = useState<Form>(initial ? formFrom(initial) : BLANK);
  const [preview, setPreview] = useState<any>(null);
  const [feeds, setFeeds] = useState<{ url: string; title?: string }[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const kindInfo = effectiveInfo(f.kind, f.kind === 'page-change' ? ({ via: f.via } as any) : ({} as any));
  const rendered = kindInfo.method === 'rendered';
  const input = toInput({ ...f, backgroundTabs: rendered ? f.backgroundTabs : false });
  const local = validateSourceInput(input);

  const test = async () => {
    setBusy('test');
    setPreview(null);
    try {
      const r = await call('preview', { input });
      if (r.errors) setErrors(r.errors);
      else {
        setErrors([]);
        setPreview(r);
      }
    } catch (e: any) {
      setErrors([e.message]);
    }
    setBusy('');
  };
  const find = async () => {
    setBusy('find');
    try {
      const r = await call('discover', { url: f.url });
      setFeeds(r.feeds ?? []);
      if (r.error) setErrors([r.error]);
    } catch (e: any) {
      setErrors([e.message]);
    }
    setBusy('');
  };
  const save = async () => {
    setBusy('save');
    try {
      if (existing && initial) {
        const r = await call('updateSource', { sourceId: initial.id, patch: { name: input.name, config: input.config, intervalMinutes: input.intervalMinutes, backgroundTabs: input.backgroundTabs } });
        if (r.errors) {
          setErrors(r.errors);
          setBusy('');
          return;
        }
        onSaved(r.source, !!r.needsApproval);
      } else {
        const r: any = await call('addSource', { input });
        if (r.errors) {
          setErrors(r.errors);
          setBusy('');
          return;
        }
        onSaved(r.source, !r.source.approval);
      }
    } catch (e: any) {
      setErrors([e.message]);
      setBusy('');
    }
  };

  const text = (label: string, k: keyof Form, hint?: string, placeholder?: string) => (
    <Field label={label} hint={hint}>
      <input value={String(f[k])} placeholder={placeholder} onChange={(e) => set(k, e.target.value as never)} />
    </Field>
  );

  return (
    <Dialog title={existing ? 'Source settings' : 'Add a source'} onClose={onCancel} wide>
      <div className="form">
        {!existing && (
          <Field label="Type" hint={KINDS[f.kind].summary}>
            <select value={f.kind} onChange={(e) => (set('kind', e.target.value as SourceKind), setPreview(null))}>
              {(Object.keys(KINDS) as SourceKind[]).map((k) => (
                <option key={k} value={k}>
                  {KINDS[k].label}
                </option>
              ))}
            </select>
          </Field>
        )}
        {text('Name', 'name', 'Shown on widgets. Defaults to the site name.')}
        {!existing && text('Address (URL)', 'url', 'Public https:// address. Private and local addresses are not allowed.', 'https://example.com/feed.xml')}
        {existing && <div className="hint mono">{f.url}</div>}
        {f.kind === 'feed' && !existing && (
          <div className="row">
            <button onClick={find} disabled={!f.url || busy === 'find'}>
              {busy === 'find' ? 'Looking…' : 'Find a feed on this page'}
            </button>
            {feeds && !feeds.length && <span className="hint">No feeds were advertised there.</span>}
            {feeds?.map((fd) => (
              <button key={fd.url} className="chip" onClick={() => (set('url', fd.url), setFeeds(null))}>
                Use {fd.title || fd.url}
              </button>
            ))}
          </div>
        )}
        {(f.kind === 'html' || f.kind === 'rendered') && (
          <>
            {text('Item selector', 'itemSelector', 'CSS selector that matches ONE item, e.g. article.post or tr.athing', 'article')}
            {text('Title selector (inside the item)', 'titleSel', 'Leave empty to use the whole item text.', 'h2')}
            {text('Link selector (inside the item)', 'linkSel', 'The first link inside is used by default.')}
            {text('Summary selector (optional)', 'summarySel')}
            <div className="row">
              {text('Date selector (optional)', 'dateSel')}
              <Field label="Date from">
                <select value={f.dateAttr} onChange={(e) => set('dateAttr', e.target.value as FieldAttr)}>
                  <option value="datetime">datetime attribute</option>
                  <option value="text">visible text</option>
                  <option value="title">title attribute</option>
                  <option value="content">content attribute</option>
                </select>
              </Field>
            </div>
            {text('Image selector (optional)', 'imageSel')}
            {f.kind === 'rendered' && text('Wait for (optional selector)', 'waitFor', 'Wait until this appears before reading (up to the limit).')}
          </>
        )}
        {f.kind === 'json' && (
          <>
            {text('List path', 'itemsPath', 'Where the array of items is, e.g. hits or data.children. Empty if the response is the list.')}
            {text('Title field', 'fTitle')}
            {text('Link field (optional)', 'fUrl')}
            {text('Summary field (optional)', 'fSummary')}
            {text('Date field (optional)', 'fPublished', 'ISO date text or epoch seconds.')}
            {text('Link template (optional)', 'urlTemplate', 'Used when an item has no link: https://example.com/item?id={id}')}
          </>
        )}
        {f.kind === 'page-change' && (
          <>
            {text('Section to watch (selector)', 'watchSel', 'The part of the page whose text should be watched, e.g. #price', '#price')}
            <Field label="Load the page with">
              <select value={f.via} onChange={(e) => set('via', e.target.value as 'fetch' | 'rendered')}>
                <option value="fetch">Plain download (no JavaScript, no sign-in)</option>
                <option value="rendered">Background tab (JavaScript and your sign-in)</option>
              </select>
            </Field>
          </>
        )}
        <div className="row">
          {f.kind !== 'page-change' && (
            <Field label="Max items">
              <input type="number" min={1} max={50} value={f.maxItems} onChange={(e) => set('maxItems', Number(e.target.value))} />
            </Field>
          )}
          <Field label="Update every (minutes)" hint={`At least ${kindInfo.minIntervalMin}. Default ${kindInfo.defaultIntervalMin}.`}>
            <input type="number" value={f.interval} placeholder={String(kindInfo.defaultIntervalMin)} onChange={(e) => set('interval', e.target.value)} />
          </Field>
        </div>
        {rendered && (
          <label className="check">
            <input type="checkbox" checked={f.backgroundTabs} onChange={(e) => set('backgroundTabs', e.target.checked)} /> Allow opening this page in a background tab (you will be asked to confirm)
          </label>
        )}
        {preview && (
          <div className="preview" aria-live="polite">
            <strong>Test result</strong>
            {preview.failure ? (
              <p className="error">{preview.failure.message}</p>
            ) : preview.watchText !== undefined ? (
              <p>Currently reads: “{preview.watchText || '(nothing found)'}”</p>
            ) : preview.items.length ? (
              <ul>
                {preview.items.map((it: any, i: number) => (
                  <li key={i}>
                    {it.title} {it.url && <span className="small muted">— {hostOf(it.url)}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p>Nothing was found.</p>
            )}
          </div>
        )}
        {(errors.length > 0 || (!local.ok && f.url)) && (
          <ul className="error" role="alert">
            {(errors.length ? errors : !local.ok ? local.errors : []).map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="actions">
        {!rendered && (
          <button onClick={test} disabled={!local.ok || busy === 'test'}>
            {busy === 'test' ? 'Testing…' : 'Test (fetch once, nothing is saved)'}
          </button>
        )}
        <button className="primary" onClick={save} disabled={!local.ok || busy === 'save'}>
          {existing ? 'Save' : 'Continue'}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------------ source list

export function SourcesPanel({ snap, sourceIds, onClose, onAdd, onEdit, onApprove }: { snap: Snapshot; sourceIds: string[]; onClose: () => void; onAdd: () => void; onEdit: (s: Source) => void; onApprove: (s: Source) => void }) {
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const act = async (id: string, op: string, extra: Record<string, unknown> = {}, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(id + op);
    try {
      const r: any = await call(op, { sourceId: id, ...extra });
      if (op === 'refresh' && r.results?.[id] && r.results[id] !== 'ran') setNote(r.results[id] === 'recent' ? 'Checked a moment ago.' : r.results[id] === 'backoff' ? 'The site asked us to wait; trying again later.' : '');
    } catch (e: any) {
      setNote(e.message);
    }
    setBusy('');
  };
  const sources = sourceIds.map((id) => snap.sources.get(id)).filter((s): s is Source => !!s);
  return (
    <aside className="drawer" aria-label="Sources">
      <div className="drawer-head">
        <h2>Sources</h2>
        <button onClick={onClose} aria-label="Close sources">
          Close
        </button>
      </div>
      {note && <p className="notice" role="status">{note}</p>}
      {!sources.length && <p className="muted">No sources yet. Add one to make widgets update by themselves.</p>}
      <ul className="source-list">
        {sources.map((s) => {
          const st = snap.states.get(s.id) as SourceState | undefined;
          const fr = freshness(s, st, Date.now(), snap.globalPaused);
          const paused = st?.status === 'paused';
          return (
            <li key={s.id} className="source">
              <div className="source-top">
                <strong>{s.name}</strong>
                <Pill tone={fr.tone}>{fr.label}</Pill>
              </div>
              <div className="small muted">
                {KINDS[s.kind].label} · {hostOf(s.url)} · every {s.intervalMinutes} min
              </div>
              {fr.detail && <div className="small">{fr.detail}</div>}
              <div className="row wrap">
                {!s.approval || st?.status === 'needs-approval' ? <button className="primary" onClick={() => onApprove(s)}>Review &amp; approve</button> : null}
                <button onClick={() => act(s.id, 'refresh', { sourceIds: [s.id] })} disabled={!!busy || !s.approval}>
                  Refresh now
                </button>
                <button onClick={() => act(s.id, 'pauseSource', { paused: !paused })} disabled={!!busy}>
                  {paused ? 'Resume' : 'Pause'}
                </button>
                <button onClick={() => onEdit(s)}>Edit</button>
                <button onClick={() => act(s.id, 'clearData', {}, 'Clear the saved items for this source? It will fetch them again on the next update.')}>Clear saved data</button>
                <button className="danger" onClick={() => act(s.id, 'removeSource', {}, `Disconnect “${s.name}” and delete its saved data? Widgets that only use it will be removed.`)}>
                  Disconnect &amp; delete
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <button className="primary" onClick={onAdd}>
        + Add source
      </button>
    </aside>
  );
}
