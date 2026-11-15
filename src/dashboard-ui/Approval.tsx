import { useState } from 'react';
import { INTERVAL, minInterval, unapprovedDomains, type Dashboard } from '../dashboard/schema';
import { call } from './data';
import { Dialog } from './ui';

/**
 * Asked before a dashboard reads any website, and again whenever it asks for more (a new site, or background tabs).
 * It lists the sites, how often, whether background tabs may open, and lets the user read the script that will run.
 */
export function ApprovalDialog({ dashboard, onDone, onCancel }: { dashboard: Dashboard; onDone: () => void; onCancel: () => void }) {
  const fresh = unapprovedDomains(dashboard);
  const expanding = !!dashboard.approval;
  const [interval, setIntervalMin] = useState(dashboard.intervalMinutes);
  const [editInterval, setEditInterval] = useState(false);
  const [tabs, setTabs] = useState(dashboard.backgroundTabs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const min = minInterval({ backgroundTabs: tabs });
  const intervalBad = !Number.isInteger(interval) || interval < min || interval > INTERVAL.max;
  const allow = async () => {
    setBusy(true);
    try {
      await call('approve', { id: dashboard.id, intervalMinutes: interval, backgroundTabs: dashboard.backgroundTabs ? tabs : false });
      onDone();
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <Dialog title={expanding ? 'Approve changed access' : 'Allow this dashboard to read websites?'} onClose={onCancel} wide>
      {expanding && <p className="notice">This dashboard now asks for more than you approved before{fresh.length ? ` (new: ${fresh.join(', ')})` : ''}. Please review it.</p>}
      <dl className="facts">
        <dt>Websites</dt>
        <dd>
          {dashboard.domains.length ? (
            <ul className="plain">
              {dashboard.domains.map((h) => (
                <li key={h}>
                  <strong>{h}</strong> {fresh.includes(h) && <span className="tag">new</span>}
                </li>
              ))}
            </ul>
          ) : (
            'None'
          )}
        </dd>
        <dt>What happens</dt>
        <dd>A script written by the assistant downloads pages or data from these websites (no cookies are sent) and reads what the dashboard shows. It can only reach the sites listed here.</dd>
        <dt>How often</dt>
        <dd>
          Every {interval} minutes{' '}
          <button className="link" onClick={() => setEditInterval((v) => !v)} aria-expanded={editInterval}>
            Change interval
          </button>
          {editInterval && (
            <div className="row">
              <input type="number" aria-label="Minutes between updates" value={interval} min={min} max={INTERVAL.max} onChange={(e) => setIntervalMin(Number(e.target.value))} />
              <span className="hint">minutes (at least {min})</span>
            </div>
          )}
          {intervalBad && <div className="error">Choose between {min} and {INTERVAL.max} minutes.</div>}
        </dd>
        {dashboard.backgroundTabs && (
          <>
            <dt>Background tabs</dt>
            <dd>
              <label className="check">
                <input type="checkbox" checked={tabs} onChange={(e) => setTabs(e.target.checked)} /> Allow opening these sites in an inactive background tab, reading them, and closing that tab. This lets the script read pages that need JavaScript or your existing sign-in.
              </label>
              <span className="hint">If you already have the page open, that tab is used and never changed or closed. WhimsyWeb never sees or stores your password.</span>
            </dd>
          </>
        )}
        <dt>Where the data goes</dt>
        <dd>It stays in this browser. It is not sent to any AI unless you paste it into the chat.</dd>
        <dt>The script</dt>
        <dd>
          <details>
            <summary>Read the script that will run</summary>
            <pre className="code">{dashboard.collect || '(none)'}</pre>
          </details>
        </dd>
      </dl>
      <p className="hint">Updates run only while the browser is running, and may be skipped if it is closed.</p>
      {error && <div className="error">{error}</div>}
      <div className="actions">
        <button className="primary" disabled={busy || intervalBad || !dashboard.domains.length} onClick={allow}>
          Allow automatic updates
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </Dialog>
  );
}
