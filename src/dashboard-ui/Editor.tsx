import { useEffect, useRef, useState } from 'react';
import { freshness } from '../dashboard/freshness';
import { approvalCovers, unapprovedDomains, type Dashboard } from '../dashboard/schema';
import { ApprovalDialog } from './Approval';
import { Chat } from './Chat';
import { call, useHistory, type Snapshot } from './data';
import { Preview, type PreviewIssue } from './Preview';
import { Field, Pill } from './ui';

type CodeFields = Pick<Dashboard, 'html' | 'css' | 'js' | 'collect' | 'domains' | 'intervalMinutes' | 'backgroundTabs'>;
const fieldsOf = (d: Dashboard): CodeFields => ({ html: d.html, css: d.css, js: d.js, collect: d.collect, domains: d.domains, intervalMinutes: d.intervalMinutes, backgroundTabs: d.backgroundTabs });
const same = (a: CodeFields, b: CodeFields) => JSON.stringify(a) === JSON.stringify(b);

type Panel = '' | 'chat' | 'code';
type Tab = 'html' | 'css' | 'js' | 'collect';

export function Editor({ id, snap, back }: { id: string; snap: Snapshot; back: () => void }) {
  const stored = snap.dashboards.find((d) => d.id === id);
  const [panel, setPanel] = useState<Panel>('chat');
  const [issues, setIssues] = useState<PreviewIssue[]>([]);
  const [approving, setApproving] = useState(false);
  const [name, setName] = useState('');
  const [nameSaved, setNameSaved] = useState(true);
  const [tab, setTab] = useState<Tab>('html');
  const [draft, setDraft] = useState<CodeFields | null>(null);
  const [codeError, setCodeError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState('');
  const hist = useHistory<CodeFields>();
  const last = useRef<CodeFields | null>(null);
  const nameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    call('open', { id }).catch(() => undefined);
  }, [id]);

  // External changes (the assistant, another tab) update the editor; the previous version stays undoable.
  useEffect(() => {
    if (!stored) return;
    const f = fieldsOf(stored);
    if (last.current && !same(last.current, f)) hist.push(last.current);
    last.current = f;
    setDraft(f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored?.html, stored?.css, stored?.js, stored?.collect, JSON.stringify(stored?.domains), stored?.intervalMinutes, stored?.backgroundTabs]);
  useEffect(() => {
    if (stored && nameSaved) setName(stored.name);
  }, [stored?.name, nameSaved]);

  // Ask for approval right away when the dashboard needs it and has not been approved yet.
  const needsApproval = !!stored && stored.collect.trim().length > 0 && !approvalCovers(stored.approval, stored);
  useEffect(() => {
    if (needsApproval && stored && stored.domains.length) setApproving(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored?.id, JSON.stringify(stored?.domains), stored?.backgroundTabs]);

  if (!snap.ready) return <p className="muted pad">Loading…</p>;
  if (!stored || !draft) {
    return (
      <div className="pad">
        <button onClick={back}>← All dashboards</button>
        <p>This dashboard no longer exists.</p>
      </div>
    );
  }

  const st = snap.states.get(id);
  const data = snap.data.get(id) ?? null;
  const fr = freshness(stored, st, Date.now(), snap.globalPaused);
  const dirty = !same(draft, fieldsOf(stored));

  const saveFields = async (f: CodeFields) => {
    setCodeError('');
    try {
      await call('save', { dashboard: { ...stored, ...f } });
      setIssues([]);
    } catch (e: any) {
      setCodeError(e.message);
    }
  };
  const undo = () => {
    const prev = hist.undo(fieldsOf(stored));
    if (prev) void saveFields(prev);
  };
  const redo = () => {
    const nxt = hist.redo(fieldsOf(stored));
    if (nxt) void saveFields(nxt);
  };
  const onName = (v: string) => {
    setName(v);
    setNameSaved(false);
    if (nameTimer.current) clearTimeout(nameTimer.current);
    nameTimer.current = setTimeout(async () => {
      await call('save', { dashboard: { ...stored, name: v } }).catch(() => undefined);
      setNameSaved(true);
    }, 600);
  };
  const refreshNow = async () => {
    setRefreshing(true);
    setNote('');
    try {
      const r: any = await call('refresh', { id });
      const v = r.results?.[id];
      setNote(v === 'recent' ? 'Checked a moment ago.' : v === 'needs-approval' ? 'Approve the websites first.' : v === 'nothing-to-do' ? 'This dashboard has nothing to collect.' : v === 'backoff' ? 'Waiting before trying again.' : '');
    } catch (e: any) {
      setNote(e.message);
    }
    setRefreshing(false);
  };
  const missing = unapprovedDomains(stored);

  return (
    <div className="editor">
      <header className="topbar">
        <button onClick={back} aria-label="Back to all dashboards">
          ← Dashboards
        </button>
        <input className="title-input" aria-label="Dashboard title" value={name} maxLength={60} onChange={(e) => onName(e.target.value)} />
        <span className="save-state small muted" role="status" aria-live="polite">
          {nameSaved ? 'All changes saved' : 'Saving…'}
        </span>
        <div className="spacer" />
        <button onClick={undo} disabled={!hist.canUndo} aria-label="Undo">
          Undo
        </button>
        <button onClick={redo} disabled={!hist.canRedo} aria-label="Redo">
          Redo
        </button>
        <button className={`refresh-btn${refreshing ? ' is-busy' : ''}`} onClick={refreshNow} disabled={refreshing || !stored.collect.trim()} aria-busy={refreshing} title={stored.collect.trim() ? 'Run the data script now' : 'This dashboard has no data script yet'}>
          <span className="refresh-icon" aria-hidden="true">
            ↻
          </span>{' '}
          {refreshing ? 'Refreshing…' : 'Refresh now'}
        </button>
        <button onClick={() => setPanel(panel === 'code' ? '' : 'code')} aria-pressed={panel === 'code'}>
          Code
        </button>
        <button onClick={() => setPanel(panel === 'chat' ? '' : 'chat')} aria-pressed={panel === 'chat'}>
          Assistant
        </button>
      </header>
      <div className="statusbar" role="status" aria-live="polite">
        <Pill tone={snap.globalPaused ? 'muted' : fr.tone}>{snap.globalPaused ? 'All background updates are paused' : fr.label}</Pill>
        {fr.detail && <span className="small muted">{fr.detail}</span>}
        <span className="small muted">Updates run while the browser is open. {note}</span>
        {needsApproval && stored.domains.length > 0 && (
          <button className="primary" onClick={() => setApproving(true)}>
            Review &amp; approve {missing.length ? missing.join(', ') : 'access'}
          </button>
        )}
      </div>
      {issues.length > 0 && (
        <div className="issues" role="alert">
          <strong>{issues[0].where === 'collect' ? 'The collect script reported a problem:' : 'The page reported a problem:'}</strong> {issues[0].message}
          {issues.length > 1 && <span className="muted"> (+{issues.length - 1} more)</span>}{' '}
          <button className="link" onClick={() => setPanel('chat')}>
            Ask the assistant to fix it
          </button>
        </div>
      )}
      <div className="workspace">
        <main className="canvas-frame">
          {!stored.html.trim() && !stored.js.trim() ? (
            <div className="empty">
              <h2>An empty dashboard</h2>
              <p>Describe it to the assistant and it will write the page and the scripts that fetch your data.</p>
              <button className="primary" onClick={() => setPanel('chat')}>
                Ask the assistant
              </button>
            </div>
          ) : (
            <Preview dashboard={stored} data={data} kv={snap.kv.get(id) ?? {}} onIssue={(i) => setIssues((cur) => (cur.some((x) => x.message === i.message) ? cur : [...cur, i].slice(-5)))} />
          )}
        </main>
        {panel === 'chat' && <Chat dashboard={stored} snap={snap} issues={issues} onClearIssues={() => setIssues([])} onClose={() => setPanel('')} onChanged={(prev, need) => (hist.push(fieldsOf(prev)), need.length && setApproving(true))} />}
        {panel === 'code' && (
          <aside className="drawer code" aria-label="Code">
            <div className="drawer-head">
              <h2>Code</h2>
              <button onClick={() => setPanel('')}>Close</button>
            </div>
            <p className="hint">For people who know HTML, CSS and JavaScript. Changes run only in the sandbox, and only on websites you approved.</p>
            <div className="seg" role="tablist" aria-label="Which part">
              {(['html', 'css', 'js', 'collect'] as Tab[]).map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} aria-pressed={tab === t} onClick={() => setTab(t)}>
                  {t === 'js' ? 'Page JS' : t === 'collect' ? 'Collect' : t.toUpperCase()}
                </button>
              ))}
            </div>
            <textarea aria-label={`${tab} code`} className="code-area" spellCheck={false} value={draft[tab]} onChange={(e) => setDraft({ ...draft, [tab]: e.target.value })} />
            <Field label="Websites the collect script reads (one per line)">
              <textarea rows={3} value={draft.domains.join('\n')} onChange={(e) => setDraft({ ...draft, domains: e.target.value.split(/\s+/).filter(Boolean) })} />
            </Field>
            <div className="row">
              <Field label="Update every (minutes)">
                <input type="number" value={draft.intervalMinutes} onChange={(e) => setDraft({ ...draft, intervalMinutes: Number(e.target.value) })} />
              </Field>
              <label className="check">
                <input type="checkbox" checked={draft.backgroundTabs} onChange={(e) => setDraft({ ...draft, backgroundTabs: e.target.checked })} /> Uses background tabs
              </label>
            </div>
            {codeError && <p className="error" role="alert">{codeError}</p>}
            <div className="row">
              <button className="primary" disabled={!dirty} onClick={() => saveFields(draft)}>
                Apply changes
              </button>
              <button disabled={!dirty} onClick={() => setDraft(fieldsOf(stored))}>
                Discard
              </button>
            </div>
          </aside>
        )}
      </div>
      {approving && stored.domains.length > 0 && <ApprovalDialog dashboard={stored} onDone={() => setApproving(false)} onCancel={() => setApproving(false)} />}
    </div>
  );
}
