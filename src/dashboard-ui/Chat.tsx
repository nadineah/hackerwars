import { useEffect, useRef, useState } from 'react';
import type { Dashboard } from '../dashboard/schema';
import { call, type Snapshot } from './data';
import type { PreviewIssue } from './Preview';

const EXAMPLES = ['A dashboard with the Hacker News front page and BBC top stories side by side, in a clean dark theme.', 'A notes pad and a list of my saved links.', 'Show the current top Wikipedia article of the day with its summary.'];

export function Chat({ dashboard, snap, issues, onChanged, onClearIssues, onClose }: { dashboard: Dashboard; snap: Snapshot; issues: PreviewIssue[]; onChanged: (previous: Dashboard, needsApproval: string[]) => void; onClearIssues: () => void; onClose: () => void }) {
  const turns = snap.chats.get(dashboard.id) ?? [];
  const [text, setText] = useState('');
  const [inspect, setInspect] = useState(false);
  const [inspectUrl, setInspectUrl] = useState('');
  const [sendErrors, setSendErrors] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [turns.length, busy]);

  const lastError = snap.states.get(dashboard.id)?.lastError;
  const errorLines = [...issues.map((i) => `${i.where === 'collect' ? 'Collect script' : 'Page'}: ${i.message}`), ...(lastError ? [`Last background update: ${lastError}`] : [])];

  const send = async () => {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setBusy(true);
    setError('');
    try {
      const r: any = await call('chat', { id: dashboard.id, prompt, inspectUrl: inspect && inspectUrl.trim() ? inspectUrl.trim() : undefined, errors: sendErrors ? errorLines : [] });
      setText('');
      setInspect(false);
      if (r.changed && r.previous) onChanged(r.previous, r.needsApproval ?? []);
      onClearIssues();
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
            <button onClick={() => call('clearChat', { id: dashboard.id })} aria-label="Clear chat history">
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
            <p>Describe the dashboard you want. The assistant writes the page and the scripts that pull from websites; you approve each website before anything is fetched.</p>
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
        {busy && <div className="muted">Writing the dashboard…</div>}
        <div ref={end} />
      </div>
      {errorLines.length > 0 && (
        <div className="notice" role="status">
          <strong>Problems seen:</strong>
          <ul className="small">
            {errorLines.slice(0, 4).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <label className="check small">
            <input type="checkbox" checked={sendErrors} onChange={(e) => setSendErrors(e.target.checked)} /> Include these error messages with my next message so the assistant can fix them
          </label>
        </div>
      )}
      {!snap.hasKey && <p className="notice">Add an Anthropic or OpenAI API key in the WhimsyWeb side panel settings to use the assistant. You can still edit the code yourself.</p>}
      <p className="hint">The assistant sees the dashboard’s code and error messages, never the data your scripts collect.</p>
      <label className="check">
        <input type="checkbox" checked={inspect} onChange={(e) => setInspect(e.target.checked)} /> Let the assistant look at a page’s structure for this message
      </label>
      {inspect && (
        <div>
          <input aria-label="Page to inspect" placeholder="https://example.com/news" value={inspectUrl} onChange={(e) => setInspectUrl(e.target.value)} />
          <p className="hint">Sends an outline of that page’s tags, ids and classes (no cookies; emails and long numbers masked) to your AI provider so it can write the right selectors.</p>
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
