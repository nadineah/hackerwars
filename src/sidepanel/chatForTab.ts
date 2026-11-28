import { appliesOn, layerOf, normalizePath, scopeOf } from '../shared/scope';
import type { Conversation, Design } from '../shared/types';

/**
 * Which chat the panel shows for the tab on screen (docs/spec-chat-follows-tab.md, section 1):
 *  1. a chat opened on purpose for this tab (a "pin"), until the tab moves to another site or page;
 *  2. the chat of the most specific theme on this page (This page > Whole site > All sites, then most recent);
 *  3. otherwise a fresh chat, with the site's last chat offered as "Continue your last chat".
 */

export interface TabRef {
  id: number;
  host: string | null;
  path: string;
}

/** A chat chosen on purpose for one tab. `convoId: null` = a fresh chat (New chat, or a new design being made). */
export interface Pin {
  convoId: string | null;
  /** Where the tab was when the pin was confirmed; null until the tab first shows a website (a new tab still loading). */
  host: string | null;
  path: string | null;
}

/** Whether a pin still holds for the tab as it is now. A pin made while the tab was loading is confirmed on first sight. */
export function pinHolds(pin: Pin, tab: TabRef): boolean {
  if (pin.host === null) return true; // not confirmed yet: the tab is still loading its first page
  return tab.host === pin.host && pin.path === tab.path;
}

/** The pin as confirmed for this tab (fills in where it is on first sight), or null if it no longer holds. */
export function confirmPin(pin: Pin, tab: TabRef): Pin | null {
  if (!pinHolds(pin, tab)) return null;
  if (pin.host === null && tab.host) return { ...pin, host: tab.host, path: tab.path };
  return pin;
}

const recency = (d: Design): number => d.lastActiveAt ?? d.updatedAt ?? d.createdAt ?? 0;

/** The themes switched on for this page, most specific first (This page, Whole site, All sites), then most recent. */
export function themesOn(designs: Design[], host: string | null, path: string): Design[] {
  if (!host) return [];
  return designs
    .filter((d) => d.enabled && appliesOn(d, host, normalizePath(path)))
    .sort((a, b) => layerOf(b) - layerOf(a) || recency(b) - recency(a) || (a.id < b.id ? -1 : 1));
}

export type TabChat =
  | { kind: 'convo'; id: string; why: 'pinned' | 'theme' }
  /** `continueId`: this site's last chat, offered as a link (never opened on its own). */
  | { kind: 'fresh'; continueId: string | null; why: 'pinned' | 'nothing' };

export function chatForTab(args: {
  tab: TabRef | null;
  pin: Pin | null;
  convos: Conversation[];
  designs: Design[];
  /** The chat last open for each site (remembered by the panel). */
  memory: Record<string, string>;
}): TabChat {
  const { tab, pin, convos, designs, memory } = args;
  const exists = (id: string | null | undefined): id is string => !!id && convos.some((c) => c.id === id);
  if (tab && pin && pinHolds(pin, tab)) {
    if (pin.convoId === null) return { kind: 'fresh', continueId: null, why: 'pinned' };
    if (exists(pin.convoId)) return { kind: 'convo', id: pin.convoId, why: 'pinned' };
  }
  if (!tab?.host) return { kind: 'fresh', continueId: null, why: 'nothing' };
  const byDesign = new Map<string, Conversation>();
  for (const c of convos) {
    if (!c.designId) continue;
    const prev = byDesign.get(c.designId);
    if (!prev || c.updatedAt > prev.updatedAt) byDesign.set(c.designId, c);
  }
  for (const d of themesOn(designs, tab.host, tab.path)) {
    const c = byDesign.get(d.id);
    if (c) return { kind: 'convo', id: c.id, why: 'theme' };
  }
  return { kind: 'fresh', continueId: lastChatFor(tab, convos, memory), why: 'nothing' };
}

/** This site's last chat (All Sites chats are not "this site's"): the one remembered for it, else the newest. */
export function lastChatFor(tab: TabRef, convos: Conversation[], memory: Record<string, string>): string | null {
  if (!tab.host) return null;
  const own = convos.filter((c) => c.host === tab.host && scopeOf({ scope: c.scope }) !== 'global');
  const mem = memory[tab.host];
  if (mem && own.some((c) => c.id === mem)) return mem;
  const newest = own.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return newest?.id ?? null;
}

/** Where a chat lives, to bring up its tab: a page (exact path), a site (any page), or all sites (any website). */
export function chatTarget(c: Conversation, design: Design | undefined): { host: string | null; path: string; exact: boolean } {
  const scope = c.scope ?? (design ? scopeOf(design) : 'site');
  if (scope === 'global') {
    const home = c.pageContext?.host ?? design?.copiedFrom?.host ?? null;
    return { host: home && home !== '*' ? home : null, path: '/', exact: false };
  }
  if (scope === 'page') return { host: c.host, path: normalizePath(c.path ?? design?.path ?? '/'), exact: true };
  return { host: c.host, path: '/', exact: false };
}
