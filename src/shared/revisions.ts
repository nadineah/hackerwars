import type { ChatMessage, Conversation } from './types';

/**
 * Linear design history for one chat. Every successful AI design turn leaves a snapshot on its reply; those
 * snapshots, in order, are the chat's revisions. `revisionIndex` says which one is applied (none = the latest).
 * Going back and then asking for a new change discards the revisions after the active one (no branches).
 */

export interface RevisionEvent {
  id: string;
  kind: 'back' | 'forward';
  /** 0-based revision indexes. */
  from: number;
  to: number;
  createdAt: number;
}

/** The chat's revisions, oldest first: assistant replies that carry a design snapshot and were not discarded. */
export const revisionsOf = (c: Pick<Conversation, 'messages'>): ChatMessage[] => c.messages.filter((m) => m.role === 'assistant' && !!m.snapshot && !m.discarded);

/** The applied revision (0-based); the latest when none was chosen. -1 when the chat has none. */
export function activeIndex(c: Pick<Conversation, 'messages' | 'revisionIndex'>): number {
  const n = revisionsOf(c).length;
  if (!n) return -1;
  const i = c.revisionIndex;
  return typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < n ? i : n - 1;
}

/** For the model: which version is on the page and which earlier changes are not applied (application context). */
export function designHistoryNote(c: Conversation): string {
  const revs = revisionsOf(c);
  if (!revs.length) return '';
  const p = activeIndex(c);
  const n = revs.length;
  const lines = [`The page shows version ${p + 1} of ${n} of this design; <current_design> is exactly that version. Base your changes on it, not on what the conversation says was done later.`];
  if (p < n - 1) lines.push(`The user went back: the changes of version${n - p > 2 ? 's' : ''} ${p + 2}${n - p > 2 ? `-${n}` : ''} are undone and NOT applied now. A new change replaces them.`);
  if (c.messages.some((m) => m.discarded)) lines.push('Replies marked "discarded" were undone and then replaced by newer changes; nothing from them is applied.');
  const lastAi = [...c.messages].reverse().find((m) => m.role === 'assistant')?.createdAt ?? 0;
  const recent = (c.events ?? []).filter((e) => e.createdAt > lastAi).slice(-4);
  if (recent.length) lines.push(`Since the last reply the user ${recent.map((e) => `went ${e.kind} from version ${e.from + 1} to ${e.to + 1}`).join(', then ')}.`);
  return lines.join('\n');
}

/** How a reply is labelled in the conversation the model sees. */
export function historyLabel(c: Conversation, m: ChatMessage): string {
  if (m.role !== 'assistant') return '';
  if (m.discarded) return '[discarded: this change was undone and replaced; not applied]';
  const revs = revisionsOf(c);
  const i = revs.indexOf(m);
  if (i < 0) return '';
  const p = activeIndex(c);
  return i > p ? `[version ${i + 1}: undone by the user, not applied now]` : `[version ${i + 1}${i === p ? ', the one applied now' : ''}]`;
}

/**
 * The messages that led to the version on the page: replies that were undone (after going Back) or discarded, and the
 * requests that produced them, are left out, so the model cannot pick their changes up again.
 */
export function appliedMessages(c: Conversation): ChatMessage[] {
  const revs = revisionsOf(c);
  const p = activeIndex(c);
  const undone = new Set(revs.slice(p + 1).map((m) => m.id));
  const out: ChatMessage[] = [];
  for (const m of c.messages) {
    if (m.role === 'assistant' && (m.discarded || undone.has(m.id))) {
      if (out[out.length - 1]?.role === 'user') out.pop(); // the request that produced it
      continue;
    }
    out.push(m);
  }
  return out;
}

/** A targeted edit: the current design stays exactly as it is and the new rules (and ops) go on top. */
export function layerEdit<T>(base: { css: string; ops: T[] }, add: { css: string; ops: T[] }): { css: string; ops: T[] } {
  const extra = add.css.trim();
  return { css: extra ? `${base.css.trimEnd()}\n\n${extra}\n` : base.css, ops: [...base.ops, ...add.ops] };
}
