import { useEffect, useRef, useState } from 'react';
import type { Dashboard } from '../dashboard/schema';
import { call, type Snapshot } from './data';

const EXAMPLES = ['Show the Hacker News front page and the BBC top stories together, newest first.', 'Add a notes widget and a saved links widget.', 'Watch the price on a product page for changes.'];

export function Chat({ dashboard, snap, onChanged, onNewSources, onClose }: { dashboard: Dashboard; snap: Snapshot; onChanged: (previous: Dashboard) => void; onNewSources: (ids: string[]) => void; onClose: () => void }) {
  const turns = snap.chats.get(dashboard.id) ?? [];
  const [text, setText] = useState('');
  const [inspect, setInspect] = useState(false);
  const [inspectUrl, setInspectUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView?.({ block: 'end' }), [turns.length, busy]);

  const send = async () => {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setBusy(true);
    setError('');
    try {
      const r: any = await call('chat', { dashboardId: dashboard.id, prompt, inspectUrl: inspect && inspectUrl.trim() ? inspectUrl.trim() : undefined });
      setText('');
      setInspect(false);
      if (r.changed && r.previous) onChanged(r.previous);
      if (r.newSourceIds?.length) onNewSources(r.newSourceIds);
    } catch (e: any) {
      setError(e.message);
    }
    setBusy(false);
  };

  return (
    <aside className="drawer chat" aria-label="Dashboard assistant">
      <div className="drawer-head">
        <h2>Assistant</h2>
        <div className="row">
          {turns.length > 0 && (
            <button onClick={() => call('clearChat', { dashboardId: dashboard.id })} aria-label="Clear chat history">
              Clear
            </button>
          )}
          <button onClick={onClose} aria-label="Collapse assistant">
            Collapse
          </button>
        </div>
      </div>
      <div className="chat-log" role="log" aria-live="polite">
        {!turns.length && (
          <div className="muted">
            <p>Describe what you want on this dashboard. The assistant proposes widgets and sources; you approve every source before anything is collected.</p>
            <ul>
              {EXAMPLES.map((e) => (
                <li key={e}>
                  <button className="link" onClick={() => setText(e)}>
                    {e}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`turn ${t.role}`}>
            <div className="bubble">{t.text}</div>
            {t.notes?.length ? (
              <ul className="notes-list">
                {t.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
        {busy && <div className="muted">Thinking…</div>}
        <div ref={end} />
      </div>
      {!snap.hasKey && <p className="notice">Add an Anthropic or OpenAI API key in the WhimsyWeb side panel settings to use the assistant. You can still build dashboards by hand.</p>}
      <p className="hint">The assistant sees your dashboard setup (names, addresses, statuses), never the items collected. Collected data is not sent to AI unless you paste it in.</p>
      <label className="check">
        <input type="checkbox" checked={inspect} onChange={(e) => setInspect(e.target.checked)} /> Let the assistant look at a page’s structure for this message
      </label>
      {inspect && (
        <div>
          <input aria-label="Page to inspect" placeholder="https://example.com/news" value={inspectUrl} onChange={(e) => setInspectUrl(e.target.value)} />
          <p className="hint">Sends an outline of that page’s tags, ids and classes (no cookies, no stored data, emails and long numbers are masked) to your AI provider so it can pick selectors.</p>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <textarea aria-label="Message to the assistant" value={text} rows={3} placeholder="Describe your dashboard…" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => (e.key === 'Enter' && (e.metaKey || e.ctrlKey) ? send() : undefined)} />
        <button className="primary" onClick={send} disabled={busy || !text.trim() || !snap.hasKey}>
          Send
        </button>
      </div>
    </aside>
  );
}
