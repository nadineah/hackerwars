'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PROTOCOL, versionAtLeast, type ErrorCode, type InstalledTheme } from '../../../theme-core/src';
import { detectExtension, fetchInstalled, sendToExtension, type Detection } from '@/lib/extension-client';

interface Props {
  themeId: string;
  versionId: string;
  version: number;
  slug: string;
  siteName: string;
  hostname: string;
  minExtensionVersion?: string;
  extensionIds: string[];
}

type Phase =
  | { t: 'detecting' }
  | { t: 'missing'; detection: Extract<Detection, { found: false }> }
  | { t: 'too-old'; have: string; need: string }
  | { t: 'ready'; extensionId: string }
  | { t: 'sent'; extensionId: string; requestId: string }
  | { t: 'applied'; message?: string; activeOnOpenTab?: boolean; version: number }
  | { t: 'declined' }
  | { t: 'failed'; code?: ErrorCode | string; message: string };

const FRIENDLY: Record<string, string> = {
  unavailable: 'This theme is no longer available (it was unpublished or removed).',
  'invalid-theme': 'The extension rejected this theme because it did not pass its safety checks.',
  integrity: 'The theme failed an integrity check, so it was not installed.',
  'too-old': 'Your extension is too old for this theme. Please update it.',
  network: 'The extension could not download the theme. Check your connection and try again.',
  'unsupported-target': 'This website is not on the supported list in your extension.',
  busy: 'Another theme request is waiting for your confirmation in the extension window.',
  declined: 'You declined the request, so nothing changed.',
  timeout: 'The extension did not answer in time. Is it enabled?',
};

export default function ApplyPanel(p: Props) {
  const [phase, setPhase] = useState<Phase>({ t: 'detecting' });
  const [installed, setInstalled] = useState<InstalledTheme | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (poll.current) clearInterval(poll.current);
    poll.current = null;
  };

  const check = useCallback(async () => {
    setPhase({ t: 'detecting' });
    const d = await detectExtension(p.extensionIds);
    if (!d.found) return setPhase({ t: 'missing', detection: d });
    const need = p.minExtensionVersion;
    if (need && !versionAtLeast(d.ping.extensionVersion, need)) return setPhase({ t: 'too-old', have: d.ping.extensionVersion, need });
    const mine = (await fetchInstalled(d.extensionId)).find((t) => t.themeId === p.themeId) ?? null;
    setInstalled(mine);
    setPhase({ t: 'ready', extensionId: d.extensionId });
  }, [p.extensionIds, p.minExtensionVersion, p.themeId]);

  useEffect(() => {
    void check();
    return stopPolling;
  }, [check]);

  async function apply(extensionId: string) {
    const r = await sendToExtension(extensionId, { type: 'whimsyweb:install', protocol: PROTOCOL, themeId: p.themeId, versionId: p.versionId }, 20_000);
    if (!r.ok || !('requestId' in r)) {
      const code = !r.ok ? r.code : 'failed';
      return setPhase({ t: 'failed', code, message: (!r.ok && FRIENDLY[code]) || (!r.ok ? r.message : 'The extension did not accept the request.') });
    }
    const requestId = r.requestId;
    setPhase({ t: 'sent', extensionId, requestId });
    const started = Date.now();
    stopPolling();
    poll.current = setInterval(async () => {
      if (Date.now() - started > 5 * 60_000) {
        stopPolling();
        return setPhase({ t: 'failed', code: 'timeout', message: 'No answer yet. If a confirmation window is open in your browser, finish it there, then try again.' });
      }
      const s = await sendToExtension(extensionId, { type: 'whimsyweb:status', protocol: PROTOCOL, requestId }, 3000);
      if (!s.ok || !('state' in s)) return; // transient: keep polling until the deadline
      if (s.state === 'awaiting-confirmation') return;
      stopPolling();
      if (s.state === 'applied') {
        setInstalled({ themeId: p.themeId, versionId: p.versionId, version: s.version ?? p.version, hostname: p.hostname, enabled: true, title: p.slug });
        return setPhase({ t: 'applied', message: s.message, activeOnOpenTab: s.activeOnOpenTab, version: s.version ?? p.version });
      }
      if (s.state === 'declined') return setPhase({ t: 'declined' });
      setPhase({ t: 'failed', code: s.code, message: (s.code && FRIENDLY[s.code]) || s.message || 'The extension could not apply the theme.' });
    }, 1000);
  }

  const updateAvailable = installed && installed.version < p.version;

  return (
    <div className="apply-box" aria-live="polite">
      <h2 style={{ fontSize: '1.1rem' }}>Apply this theme</h2>
      <p className="small muted">Applies to <strong>{p.siteName}</strong> only, through the Whimsy Web extension. The extension asks you to confirm before anything changes.</p>

      {phase.t === 'detecting' && <p className="status-line muted">Looking for the extension…</p>}

      {phase.t === 'missing' && (
        <div className="stack">
          <div className="alert warn">{phase.detection.message}</div>
          <Link className="btn" href={`/install?theme=${encodeURIComponent(p.slug)}`}>Install the extension</Link>
          <button className="btn secondary" type="button" onClick={() => void check()}>I installed it: check again</button>
        </div>
      )}

      {phase.t === 'too-old' && (
        <div className="stack">
          <div className="alert warn">This theme needs extension version {phase.need} or newer. You have {phase.have}.</div>
          <Link className="btn secondary" href="/install">How to update</Link>
        </div>
      )}

      {phase.t === 'ready' && (
        <div className="stack">
          {installed && !updateAvailable && (
            <div className="alert ok">Version {installed.version} is installed{installed.enabled ? ' and on.' : ' but switched off in the extension.'}</div>
          )}
          {updateAvailable && <div className="alert info">You have version {installed!.version}. Version {p.version} is available.</div>}
          <button className="btn" type="button" onClick={() => void apply(phase.extensionId)}>
            {updateAvailable ? `Update to version ${p.version}` : installed ? 'Apply again' : 'Apply theme'}
          </button>
        </div>
      )}

      {phase.t === 'sent' && (
        <div className="alert info status-line">
          <strong>Waiting for your confirmation.</strong> A small Whimsy Web window opened in your browser. Review it and choose <em>Apply</em>. Nothing has changed yet.
        </div>
      )}

      {phase.t === 'applied' && (
        <div className="stack">
          <div className="alert ok"><strong>Applied.</strong> The extension confirmed version {phase.version} is installed and on for {p.siteName}.</div>
          {phase.activeOnOpenTab ? (
            <p className="small muted">It is already active on a {p.siteName} tab you have open.</p>
          ) : (
            <a className="btn secondary" href={`https://${p.hostname}/`} target="_blank" rel="noopener noreferrer">Open {p.siteName} to see it</a>
          )}
          <p className="small muted">Undo any time: open the Whimsy Web panel on {p.siteName}, and press “Turn off”.</p>
        </div>
      )}

      {phase.t === 'declined' && (
        <div className="stack">
          <div className="alert info">You declined, so nothing changed.</div>
          <button className="btn secondary" type="button" onClick={() => void check()}>Try again</button>
        </div>
      )}

      {phase.t === 'failed' && (
        <div className="stack">
          <div className="alert error">{phase.message}</div>
          <button className="btn secondary" type="button" onClick={() => void check()}>Try again</button>
        </div>
      )}
    </div>
  );
}
