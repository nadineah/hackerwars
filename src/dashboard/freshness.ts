import { approvalCovers, type DashState, type Dashboard } from './schema';
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
 * The honest, one-line freshness of a dashboard's data. It only states what the stored state proves: it never says
 * "up to date" for something that failed, and never implies an update happens while paused or unapproved.
 */
export function freshness(d: Dashboard, st: DashState | null | undefined, now = Date.now(), globalPaused = false): Fresh {
  if (!d.collect.trim()) return { label: 'No background data', detail: 'This dashboard does not collect anything from websites.', tone: 'muted' };
  if (!approvalCovers(d.approval, d)) return { label: 'Permission needed', detail: 'Approve the sites this dashboard reads to start collecting.', tone: 'warn' };
  if (d.paused || st?.status === 'paused') return { label: 'Paused', detail: st?.lastSuccessAt ? `Showing data from ${ago(st.lastSuccessAt, now)}.` : undefined, tone: 'muted' };
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

export type CardStatus = 'current' | 'updating' | 'paused' | 'attention' | 'static' | 'empty';
export const STATUS_LABEL: Record<CardStatus, string> = { current: 'Current', updating: 'Updating', paused: 'Paused', attention: 'Needs attention', static: 'No live data', empty: 'Empty' };

/** Library-card status: paused beats everything; then running; then anything needing the user. */
export function cardStatus(d: Dashboard, st: DashState | undefined, globalPaused: boolean): CardStatus {
  if (!d.html.trim() && !d.js.trim()) return 'empty';
  if (!d.collect.trim()) return 'static';
  if (d.paused || globalPaused || st?.status === 'paused') return 'paused';
  if (!approvalCovers(d.approval, d)) return 'attention';
  if (st?.status === 'running') return 'updating';
  if (st && ['needs-signin', 'needs-attention', 'needs-approval', 'error'].includes(st.status)) return 'attention';
  return 'current';
}
