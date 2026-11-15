import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ACCENTS, approvalCovers, type Dashboard, type Source, type Widget } from '../dashboard/schema';
import { Chat } from './Chat';
import { call, useHistory, type Snapshot } from './data';
import { ApprovalDialog, SourceForm, SourcesPanel } from './Sources';
import { Dialog, Field, Pill } from './ui';
import { WIDGET_TYPES, WidgetCard, WidgetSettings, blankWidget } from './Widgets';

const norm = (d: Dashboard) => JSON.stringify({ ...d, updatedAt: 0 });
const MODE_KEY = 'ww-dash-mode';
const readMode = (): 'edit' | 'view' => {
  try {
    return localStorage.getItem(MODE_KEY) === 'view' ? 'view' : 'edit';
  } catch {
    return 'edit';
  }
};

type Save = 'saved' | 'saving' | 'error';

export function Editor({ id, snap, back }: { id: string; snap: Snapshot; back: () => void }) {
  const stored = snap.dashboards.find((d) => d.id === id);
  const [draft, setDraft] = useState<Dashboard | null>(null);
  const [mode, setMode] = useState<'edit' | 'view'>(readMode);
  const [save, setSave] = useState<Save>('saved');
  const [saveError, setSaveError] = useState('');
  const [panel, setPanel] = useState<'' | 'sources' | 'chat'>('');
  const [dialog, setDialog] = useState<'' | 'add-widget' | 'appearance' | 'add-source'>('');
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [editSource, setEditSource] = useState<Source | null>(null);
  const [approveQueue, setApproveQueue] = useState<string[]>([]);
  const [pendingWidget, setPendingWidget] = useState<Widget['type'] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState('');
  const hist = useHistory<Dashboard>();
  const lastSeen = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);
  const draftRef = useRef<Dashboard | null>(null);
  draftRef.current = draft;

  // Cached data shows immediately (the page reads storage); only stale sources are refreshed in the background.
  useEffect(() => {
    call('open', { dashboardId: id }).catch(() => undefined);
  }, [id]);

  // External changes (the assistant, another tab) replace the draft; the previous version stays undoable.
  useEffect(() => {
    if (!stored) return;
    const n = norm(stored);
    if (n === lastSeen.current) return;
    lastSeen.current = n;
    if (!dirty.current) {
      if (draftRef.current && norm(draftRef.current) !== n) hist.push(draftRef.current);
      setDraft(stored);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored]);

  const flush = useCallback(async (d: Dashboard) => {
    setSave('saving');
    try {
      const r: any = await call('save', { dashboard: d });
      lastSeen.current = norm(r.dashboard);
      dirty.current = false;
      setSave('saved');
      setSaveError('');
    } catch (e: any) {
      setSave('error');
      setSaveError(e.message);
    }
  }, []);

  const commit = useCallback(
    (next: Dashboard, opts: { record?: boolean; immediate?: boolean } = {}) => {
      if (opts.record !== false && draftRef.current) hist.push(draftRef.current);
      setDraft(next);
      dirty.current = true;
      setSave('saving');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(next), opts.immediate ? 0 : 600);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flush],
  );

  // Never lose an edit made in the last moments before the tab closes.
  useEffect(() => {
    const onHide = () => {
      if (dirty.current && draftRef.current) void call('save', { dashboard: draftRef.current }).catch(() => undefined);
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      if (timer.current) clearTimeout(timer.current);
      onHide();
    };
  }, []);

  const sourceIds = useMemo(() => {
    const ids = new Set<string>();
    for (const w of draft?.widgets ?? []) {
      if (w.type === 'updates') w.sourceIds.forEach((x) => ids.add(x));
      else if (w.type === 'list' || w.type === 'page-change') ids.add(w.sourceId);
    }
    return [...ids].filter((x) => snap.sources.has(x));
  }, [draft, snap.sources]);

  if (!snap.ready) return <p className="muted pad">Loading…</p>;
  if (!stored || !draft) {
    return (
      <div className="pad">
        <button onClick={back}>← All dashboards</button>
        <p>This dashboard no longer exists.</p>
      </div>
    );
  }

  const editing = mode === 'edit';
  const setWidgets = (widgets: Widget[], immediate = false) => commit({ ...draft, widgets }, { immediate });
  const updateWidget = (w: Widget) => setWidgets(draft.widgets.map((x) => (x.id === w.id ? w : x)));
  const sources = sourceIds.map((x) => snap.sources.get(x)!);
  const attention = sources.filter((s) => {
    const st = snap.states.get(s.id);
    return !approvalCovers(s.approval, s) || (st && ['needs-signin', 'needs-attention', 'needs-approval', 'error'].includes(st.status));
  }).length;
  const running = sources.some((s) => snap.states.get(s.id)?.status === 'running');
  const approving = approveQueue.length ? snap.sources.get(approveQueue[0]) : undefined;

  const undo = () => {
    const prev = hist.undo(draft);
    if (prev) commit(prev, { record: false, immediate: true });
  };
  const redo = () => {
    const nxt = hist.redo(draft);
    if (nxt) commit(nxt, { record: false, immediate: true });
  };
  const refreshAll = async () => {
    setRefreshing(true);
    setNote('');
    try {
      const r: any = await call('refresh', { dashboardId: id });
      const vals = Object.values(r.results ?? {});
      setNote(vals.length ? (vals.every((v) => v === 'recent') ? 'Everything was checked a moment ago.' : vals.some((v) => v === 'needs-approval') ? 'Some sources need your approval first.' : '') : 'No sources to refresh.');
    } catch (e: any) {
      setNote(e.message);
    }
    setRefreshing(false);
  };
  const setModeSaved = (m: 'edit' | 'view') => {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* fine */
    }
  };
  const addWidget = (type: Widget['type']) => {
    const needs = WIDGET_TYPES.find((t) => t.type === type)!.needsSource;
    const candidates = [...snap.sources.values()].filter((s) => (type === 'page-change' ? s.kind === 'page-change' : s.kind !== 'page-change'));
    setDialog('');
    if (needs && !candidates.length) {
      setPendingWidget(type);
      setDialog('add-source');
      return;
    }
    const w = blankWidget(type, needs ? [candidates[0].id] : []);
    setWidgets([...draft.widgets, w], true);
    if (needs) setSettingsFor(w.id);
  };
  const sourceSaved = (s: Source, needsApproval: boolean) => {
    setDialog('');
    setEditSource(null);
    if (pendingWidget) {
      const w = blankWidget(pendingWidget, [s.id]);
      setWidgets([...draft.widgets, w], true);
      setPendingWidget(null);
    }
    if (needsApproval) setApproveQueue((q) => [...q, s.id]);
  };
  const settingsWidget = draft.widgets.find((w) => w.id === settingsFor);

  return (
    <div className={`editor mode-${draft.theme.mode} accent-${draft.theme.accent}${draft.theme.mono ? ' mono-on' : ''}`} data-mode={draft.theme.mode} data-accent={draft.theme.accent}>
      <header className="topbar">
        <button onClick={back} aria-label="Back to all dashboards">
          ← Dashboards
        </button>
        {editing ? <input className="title-input" aria-label="Dashboard title" value={draft.name} maxLength={60} onChange={(e) => commit({ ...draft, name: e.target.value })} /> : <h1 className="title">{draft.name}</h1>}
        <span className="save-state small muted" role="status" aria-live="polite">
          {save === 'saving' ? 'Saving…' : save === 'error' ? `Not saved: ${saveError}` : 'All changes saved'}
        </span>
        <div className="spacer" />
        <div className="seg" role="group" aria-label="Mode">
          <button aria-pressed={editing} onClick={() => setModeSaved('edit')}>
            Edit
          </button>
          <button aria-pressed={!editing} onClick={() => setModeSaved('view')}>
            View
          </button>
        </div>
        {editing && (
          <>
            <button onClick={undo} disabled={!hist.canUndo} aria-label="Undo">
              Undo
            </button>
            <button onClick={redo} disabled={!hist.canRedo} aria-label="Redo">
              Redo
            </button>
            <button onClick={() => setDialog('appearance')}>Appearance</button>
            <button className="primary" onClick={() => setDialog('add-widget')}>
              + Add widget
            </button>
          </>
        )}
        <button onClick={refreshAll} disabled={refreshing || !sources.length}>
          {refreshing ? 'Refreshing…' : 'Refresh all'}
        </button>
        <button onClick={() => setPanel(panel === 'sources' ? '' : 'sources')} aria-pressed={panel === 'sources'}>
          Sources ({sourceIds.length})
        </button>
        <button onClick={() => setPanel(panel === 'chat' ? '' : 'chat')} aria-pressed={panel === 'chat'}>
          Assistant
        </button>
      </header>
      <div className="statusbar" role="status" aria-live="polite">
        {snap.globalPaused ? <Pill tone="muted">All background updates are paused</Pill> : draft.paused ? <Pill tone="muted">This dashboard is paused</Pill> : running ? <Pill tone="busy">Updating…</Pill> : attention ? <Pill tone="warn">{attention} source{attention > 1 ? 's' : ''} need attention</Pill> : sources.length ? <Pill tone="ok">Background updates on</Pill> : <Pill tone="muted">No sources connected</Pill>}
        <span className="small muted">Updates run while the browser is open. {note}</span>
      </div>
      <div className="workspace">
        <main className="canvas" style={{ ['--cols' as string]: draft.columns }}>
          {!draft.widgets.length && (
            <div className="empty">
              <h2>An empty canvas</h2>
              <p>Add a widget, or ask the assistant to build this dashboard for you.</p>
              <div className="row">
                <button className="primary" onClick={() => setDialog('add-widget')}>
                  + Add widget
                </button>
                <button onClick={() => setPanel('chat')}>Ask the assistant</button>
              </div>
            </div>
          )}
          {draft.widgets.map((w, i) => (
            <WidgetCard
              key={w.id}
              w={w}
              snap={snap}
              editing={editing}
              index={i}
              count={draft.widgets.length}
              onChange={updateWidget}
              onMove={(dir) => {
                const arr = draft.widgets.slice();
                [arr[i], arr[i + dir]] = [arr[i + dir], arr[i]];
                setWidgets(arr, true);
              }}
              onRemove={() => setWidgets(draft.widgets.filter((x) => x.id !== w.id), true)}
              onSettings={() => setSettingsFor(w.id)}
            />
          ))}
        </main>
        {panel === 'sources' && (
          <SourcesPanel
            snap={snap}
            sourceIds={sourceIds}
            onClose={() => setPanel('')}
            onAdd={() => setDialog('add-source')}
            onEdit={setEditSource}
            onApprove={(s) => setApproveQueue((q) => [...q, s.id])}
          />
        )}
        {panel === 'chat' && (
          <Chat
            dashboard={draft}
            snap={snap}
            onClose={() => setPanel('')}
            onChanged={(prev) => hist.push(prev)}
            onNewSources={(ids) => setApproveQueue((q) => [...q, ...ids])}
          />
        )}
      </div>

      {dialog === 'add-widget' && (
        <Dialog title="Add a widget" onClose={() => setDialog('')}>
          <ul className="choices">
            {WIDGET_TYPES.map((t) => (
              <li key={t.type}>
                <button className="choice" onClick={() => addWidget(t.type)}>
                  <strong>{t.label}</strong>
                  <span className="muted small">{t.blurb}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="actions">
            <button onClick={() => setDialog('')}>Cancel</button>
          </div>
        </Dialog>
      )}
      {dialog === 'appearance' && (
        <Dialog title="Appearance" onClose={() => setDialog('')}>
          <div className="form">
            <Field label="Mode">
              <select value={draft.theme.mode} onChange={(e) => commit({ ...draft, theme: { ...draft.theme, mode: e.target.value as 'auto' } })}>
                <option value="auto">Match system</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </Field>
            <Field label="Accent">
              <select value={draft.theme.accent} onChange={(e) => commit({ ...draft, theme: { ...draft.theme, accent: e.target.value as 'ink' } })}>
                {ACCENTS.map((a) => (
                  <option key={a} value={a}>
                    {a[0].toUpperCase() + a.slice(1)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Columns">
              <select value={draft.columns} onChange={(e) => commit({ ...draft, columns: Number(e.target.value) as 1 | 2 | 3 })}>
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
              </select>
            </Field>
            <label className="check">
              <input type="checkbox" checked={draft.theme.mono} onChange={(e) => commit({ ...draft, theme: { ...draft.theme, mono: e.target.checked } })} /> Grayscale
            </label>
            <label className="check">
              <input type="checkbox" checked={draft.paused} onChange={(e) => commit({ ...draft, paused: e.target.checked }, { immediate: true })} /> Pause background updates for this dashboard
            </label>
          </div>
          <div className="actions">
            <button className="primary" onClick={() => setDialog('')}>
              Done
            </button>
          </div>
        </Dialog>
      )}
      {(dialog === 'add-source' || editSource) && <SourceForm initial={editSource ?? undefined} existing={!!editSource} onSaved={sourceSaved} onCancel={() => (setDialog(''), setEditSource(null), setPendingWidget(null))} />}
      {settingsWidget && (
        <WidgetSettings
          w={settingsWidget}
          snap={snap}
          onClose={() => setSettingsFor(null)}
          onSave={(w) => (updateWidget(w), setSettingsFor(null))}
          onAddSource={() => setDialog('add-source')}
        />
      )}
      {approving && <ApprovalDialog key={approving.id} src={approving} existing={approving.approval} onDone={() => setApproveQueue((q) => q.slice(1))} onCancel={() => setApproveQueue((q) => q.slice(1))} />}
    </div>
  );
}
