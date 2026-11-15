import { approvalCovers, type Dashboard, type Source, type SourceState } from './schema';
import { sourceIdsOf } from './store';
import { ago, inFuture } from './util';

export type Tone = 'ok' | 'busy' | 'warn' | 'muted';
export interface Fresh {
  label: string;
  /** A second line with the detail (error text, next check) when there is one. */
  detail?: string;
  tone: Tone;
}

const NEVER = 8.64e15;

/**
 * The honest, one-line freshness of a source. It only ever states what the stored state proves: it never says
 * "up to date" for something that failed, and never implies an update happens while paused or unapproved.
 */
export function freshness(src: Source, st: SourceState | null | undefined, now = Date.now(), globalPaused = false): Fresh {
  if (!approvalCovers(src.approval, src)) return { label: 'Permission needed', detail: 'Approve automatic updates to start collecting.', tone: 'warn' };
  if (st?.status === 'paused') return { label: 'Paused', detail: st.lastSuccessAt ? `Showing data from ${ago(st.lastSuccessAt, now)}.` : undefined, tone: 'muted' };
  if (st?.status === 'running') return { label: 'Updating…', tone: 'busy' };
  if (st?.status === 'needs-signin') return { label: 'Sign-in required', detail: st.lastError, tone: 'warn' };
  if (st?.status === 'needs-attention') return { label: 'Needs attention', detail: st.lastError, tone: 'warn' };
  if (st?.status === 'needs-approval') return { label: 'Permission needed', detail: st.lastError, tone: 'warn' };
  if (st?.status === 'error') {
    return st.lastSuccessAt
      ? { label: 'Showing saved data; refresh failed', detail: `${st.lastError ?? ''} Last updated ${ago(st.lastSuccessAt, now)}.${st.nextCheckAt < NEVER && !globalPaused ? ` Trying again ${inFuture(st.nextCheckAt, now)}.` : ''}`.trim(), tone: 'warn' }
      : { label: 'Could not update yet', detail: st.lastError, tone: 'warn' };
  }
  if (!st?.lastSuccessAt) return { label: 'Waiting for the first update', tone: 'busy' };
  const next = globalPaused ? 'Automatic updates are paused.' : `Next check ${inFuture(Math.max(st.nextCheckAt, now), now)}.`;
  if (st.lastChangeAt !== undefined && Math.abs(st.lastChangeAt - st.lastSuccessAt) < 2000) return { label: `Updated ${ago(st.lastSuccessAt, now)}`, detail: next, tone: 'ok' };
  return { label: `Checked ${ago(st.lastSuccessAt, now)}; no changes`, detail: st.lastChangeAt ? `Last change ${ago(st.lastChangeAt, now)}. ${next}` : next, tone: 'ok' };
}

export type DashStatus = 'current' | 'updating' | 'paused' | 'attention' | 'empty';

/** Library-card status: paused beats everything; then anything running; then any source needing the user. */
export function dashboardStatus(d: Dashboard, sources: Map<string, Source>, states: Map<string, SourceState>, globalPaused: boolean): DashStatus {
  if (d.paused || globalPaused) return 'paused';
  const ids = sourceIdsOf(d);
  if (!ids.length) return 'empty';
  let attention = false;
  for (const id of ids) {
    const src = sources.get(id);
    const st = states.get(id);
    if (!src || !approvalCovers(src.approval, src)) attention = true;
    else if (st?.status === 'running') return 'updating';
    else if (st && ['needs-signin', 'needs-attention', 'needs-approval', 'error'].includes(st.status)) attention = true;
  }
  return attention ? 'attention' : 'current';
}

export const STATUS_LABEL: Record<DashStatus, string> = { current: 'Current', updating: 'Updating', paused: 'Paused', attention: 'Needs attention', empty: 'No sources yet' };

/** The most recent successful update across a dashboard's sources, for the library card. */
export function lastSuccess(d: Dashboard, states: Map<string, SourceState>): number | undefined {
  const t = sourceIdsOf(d).map((id) => states.get(id)?.lastSuccessAt ?? 0);
  const m = Math.max(0, ...t);
  return m || undefined;
}
