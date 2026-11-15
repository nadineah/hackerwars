'use client';

import { useActionState } from 'react';
import { reportThemeAction } from '@/app/actions';
import { REPORT_REASONS } from '@/lib/validation';

export default function ReportForm({ themeId }: { themeId: string }) {
  const [state, action, pending] = useActionState(reportThemeAction, null);
  return (
    <details className="source">
      <summary>Report this theme</summary>
      <form action={action} className="stack" style={{ marginTop: 12 }}>
        <input type="hidden" name="themeId" value={themeId} />
        <div className="field">
          <label htmlFor="reason">What is wrong?</label>
          <select id="reason" name="reason" required defaultValue="">
            <option value="" disabled>Choose a reason…</option>
            {REPORT_REASONS.map((r) => (
              <option key={r.id} value={r.id}>{r.label}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="detail">Details <span className="hint">(optional)</span></label>
          <textarea id="detail" name="detail" maxLength={600} style={{ minHeight: 80 }} />
        </div>
        {state?.error && <div className="alert error" role="alert">{state.error}</div>}
        {state?.ok && <div className="alert ok" role="status">{state.ok}</div>}
        <button className="btn secondary small" disabled={pending}>{pending ? 'Sending…' : 'Send report'}</button>
      </form>
    </details>
  );
}
