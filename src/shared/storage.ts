import { GLOBAL_HOST, slotOf } from './scope';
import {
  DEFAULT_MODEL,
  emptyTotals,
  type Conversation,
  type Design,
  type DesignScope,
  type Provider,
  type Settings,
  type Usage,
  type UsageStats,
  type UsageTotals,
} from './types';

/**
 * Storage layout (chrome.storage.local):
 *   site:<hostname> -> Design[]   one key per site (site-wide AND page-scoped designs), so the
 *                                 content script only ever reads its own site's designs
 *   convo:<id>      -> Conversation
 *   settings        -> Settings   (never read by content scripts)
 *
 * Reads are safe from any context. WRITES to site keys must go through the
 * background worker's serialized queue (see background/index.ts) to avoid
 * lost updates from concurrent read-modify-write cycles.
 */
export const siteKey = (host: string) => `site:${host}`;
export const isSiteKey = (k: string) => k.startsWith('site:');

const byNewest = (a: Design, b: Design) => b.updatedAt - a.updatedAt;

export async function getDesignsForHost(host: string): Promise<Design[]> {
  const key = siteKey(host);
  const res = await chrome.storage.local.get(key);
  return ((res[key] as Design[] | undefined) ?? []).slice().sort(byNewest);
}

/** Every saved design across all sites. Called from trusted contexts only (panel, background). */
export async function getAllDesigns(): Promise<Design[]> {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => isSiteKey(k))
    .flatMap(([, v]) => v as Design[])
    .sort(byNewest);
}

async function writeSite(host: string, designs: Design[]): Promise<void> {
  const key = siteKey(host);
  if (designs.length === 0) await chrome.storage.local.remove(key);
  else await chrome.storage.local.set({ [key]: designs });
}

// ---- Mutations (background queue only) ---------------------------------

/** Turns off every OTHER enabled design that occupies the same slot as `target`. */
function disableSlotMates(list: Design[], target: Design, now: number): Design[] {
  const slot = slotOf(target);
  return list.map((d) => (d.id !== target.id && d.enabled && slotOf(d) === slot ? { ...d, enabled: false, updatedAt: now } : d));
}

export async function upsertDesign(design: Design, opts: { exclusive?: boolean } = {}): Promise<void> {
  const now = Date.now();
  const saved = { ...design, updatedAt: now };
  let next = (await getDesignsForHost(design.host)).filter((d) => d.id !== design.id);
  if (opts.exclusive && saved.enabled) next = disableSlotMates(next, saved, now);
  next.push(saved);
  await writeSite(design.host, next);
}

/**
 * Saves a design and its conversation in ONE storage write, so a failure (or a Stop) can never leave
 * the design applied without its conversation. `shouldAbort` is checked after the last read and
 * immediately before the write; returns false if the write was skipped.
 */
export async function commitDesignAndConversation(
  design: Design,
  convo: Conversation,
  opts: { exclusive?: boolean; shouldAbort?: () => boolean } = {},
): Promise<boolean> {
  const now = Date.now();
  const saved = { ...design, updatedAt: now };
  let next = (await getDesignsForHost(design.host)).filter((d) => d.id !== design.id);
  if (opts.exclusive && saved.enabled) next = disableSlotMates(next, saved, now);
  next.push(saved);
  if (opts.shouldAbort?.()) return false;
  await chrome.storage.local.set({ [siteKey(design.host)]: next, [convoKey(convo.id)]: convo });
  return true;
}

export async function patchDesign(host: string, id: string, patch: Partial<Design>): Promise<void> {
  const list = await getDesignsForHost(host);
  await writeSite(
    host,
    list.map((d) => (d.id === id ? { ...d, ...patch, id: d.id, host: d.host, updatedAt: Date.now() } : d)),
  );
}

export async function removeDesign(host: string, id: string): Promise<void> {
  const list = await getDesignsForHost(host);
  const gone = list.find((d) => d.id === id);
  let next = list.filter((d) => d.id !== id);
  // Removing a community theme puts back what it replaced: the previous designs it switched off.
  if (gone?.community && gone.enabled) next = restoreDisplaced(next, gone.community.displacedIds);
  await writeSite(host, next);
}

function restoreDisplaced(list: Design[], ids: string[]): Design[] {
  const now = Date.now();
  let out = list;
  for (const id of ids) {
    const d = out.find((x) => x.id === id);
    // Only if it still exists and nothing else has taken its slot in the meantime.
    if (d && !d.enabled && !out.some((x) => x.enabled && slotOf(x) === slotOf(d))) out = out.map((x) => (x.id === id ? { ...x, enabled: true, updatedAt: now } : x));
  }
  return out;
}

/**
 * Installs (or updates in place) a community theme as the enabled site-wide design of its host. Whatever was
 * enabled in that slot is switched off, and its ids are remembered so Remove can restore it. Updating keeps the
 * list of things it originally displaced. One atomic write.
 */
export async function installCommunityDesign(design: Design): Promise<{ displacedIds: string[]; replaced: Design | null }> {
  const now = Date.now();
  const list = await getDesignsForHost(design.host);
  const prior = list.find((d) => d.community?.themeId === design.community!.themeId) ?? null;
  const mates = list.filter((d) => d.id !== prior?.id && d.enabled && slotOf(d) === slotOf(design));
  const displacedIds = [...new Set([...(prior?.community?.displacedIds ?? []), ...mates.map((d) => d.id)])];
  const saved: Design = { ...design, id: prior?.id ?? design.id, createdAt: prior?.createdAt ?? design.createdAt, updatedAt: now, community: { ...design.community!, displacedIds } };
  const next = list.filter((d) => d.id !== prior?.id).map((d) => (d.enabled && slotOf(d) === slotOf(saved) ? { ...d, enabled: false, updatedAt: now } : d));
  next.push(saved);
  await writeSite(design.host, next);
  return { displacedIds, replaced: prior };
}

/** All designs installed from the community website, across sites (for the "installed" query). */
export async function getCommunityDesigns(): Promise<Design[]> {
  return (await getAllDesigns()).filter((d) => !!d.community);
}

/**
 * Turns one design on or off. Turning one on only displaces designs in the SAME slot
 * (site-wide vs. that page). `id = null` turns every design for the host off.
 */
export async function activateDesign(host: string, id: string | null, enabled = true): Promise<void> {
  const list = await getDesignsForHost(host);
  const now = Date.now();
  if (id === null) {
    await writeSite(host, list.map((d) => (d.enabled ? { ...d, enabled: false, updatedAt: now } : d)));
    return;
  }
  const target = list.find((d) => d.id === id);
  if (!target) return;
  const updated = { ...target, enabled, updatedAt: now };
  let next = list.map((d) => (d.id === id ? updated : d));
  if (enabled) next = disableSlotMates(next, updated, now);
  await writeSite(host, next);
}

/**
 * Moves a design between "all sites", "whole site" and "this page". `host` is the site being looked
 * at; the design may currently live in that site's list or in the all-sites list, and moving it to or
 * from "all sites" changes which list it is stored in. Both lists are written in one call.
 */
export async function setDesignScope(host: string, id: string, scope: DesignScope, path: string): Promise<void> {
  const now = Date.now();
  const lists = new Map<string, Design[]>([
    [host, await getDesignsForHost(host)],
    [GLOBAL_HOST, host === GLOBAL_HOST ? [] : await getDesignsForHost(GLOBAL_HOST)],
  ]);
  const target = [...lists.values()].flat().find((d) => d.id === id);
  if (!target) return;
  const destHost = scope === 'global' ? GLOBAL_HOST : host;
  const updated: Design = {
    ...target,
    host: destHost,
    scope,
    path: scope === 'page' ? path : undefined,
    excludedHosts: scope === 'global' ? target.excludedHosts : undefined,
    updatedAt: now,
  };
  for (const [h, list] of lists) lists.set(h, list.filter((d) => d.id !== id));
  let dest = lists.get(destHost) ?? [];
  dest = [...dest, updated];
  if (updated.enabled) dest = disableSlotMates(dest, updated, now);
  lists.set(destHost, dest);
  // ONE write for both buckets, so a failure can never leave the design in both (a leftover copy would
  // ignore the all-sites exclusions). An emptied bucket is written as [] and tidied up afterwards.
  const all: Record<string, Design[]> = {};
  for (const [h, list] of lists) all[siteKey(h)] = list;
  await chrome.storage.local.set(all);
  const emptied = Object.entries(all).filter(([, list]) => list.length === 0).map(([k]) => k);
  if (emptied.length) await chrome.storage.local.remove(emptied).catch(() => undefined);
}

/** Turns an all-sites design off (or back on) for ONE site, without touching it anywhere else. */
export async function setHostExclusion(id: string, siteHost: string, excluded: boolean): Promise<void> {
  const list = await getDesignsForHost(GLOBAL_HOST);
  await writeSite(
    GLOBAL_HOST,
    list.map((d) => {
      if (d.id !== id) return d;
      const set = new Set(d.excludedHosts ?? []);
      if (excluded) set.add(siteHost);
      else set.delete(siteHost);
      return { ...d, excludedHosts: [...set], updatedAt: Date.now() };
    }),
  );
}

/** One-time migration from the v0 single-map layout (`designs`). */
export async function migrateLegacy(): Promise<void> {
  const { designs } = await chrome.storage.local.get('designs');
  if (!designs || typeof designs !== 'object') return;
  const byHost = new Map<string, Design[]>();
  for (const d of Object.values(designs as Record<string, Design>)) {
    byHost.set(d.host, [...(byHost.get(d.host) ?? []), d]);
  }
  for (const [host, list] of byHost) {
    const existing = await getDesignsForHost(host);
    const ids = new Set(existing.map((d) => d.id));
    await writeSite(host, [...existing, ...list.filter((d) => !ids.has(d.id))]);
  }
  await chrome.storage.local.remove('designs');
}

// ---- Conversations -------------------------------------------------------

export const convoKey = (id: string) => `convo:${id}`;
export const isConvoKey = (k: string) => k.startsWith('convo:');

/** Reads every conversation. Called from trusted contexts only (panel, background). */
export async function getAllConversations(): Promise<Conversation[]> {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => isConvoKey(k))
    .map(([, v]) => v as Conversation)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getConversation(id: string): Promise<Conversation | undefined> {
  const key = convoKey(id);
  const res = await chrome.storage.local.get(key);
  return res[key] as Conversation | undefined;
}

export async function putConversation(c: Conversation): Promise<void> {
  await chrome.storage.local.set({ [convoKey(c.id)]: c });
}

export async function deleteConversation(id: string): Promise<void> {
  await chrome.storage.local.remove(convoKey(id));
}

// ---- Token usage ---------------------------------------------------------
// Written only from the background worker's serialized queue (read-modify-write).

const USAGE_KEY = 'usage';

export async function getUsage(): Promise<UsageStats> {
  const res = await chrome.storage.local.get(USAGE_KEY);
  const u = (res[USAGE_KEY] as Partial<UsageStats> | undefined) ?? {};
  return {
    since: typeof u.since === 'number' ? u.since : null,
    anthropic: { ...emptyTotals(), ...u.anthropic },
    openai: { ...emptyTotals(), ...u.openai },
    byModel: u.byModel ?? {},
  };
}

const addTo = (t: UsageTotals, u: Usage): UsageTotals => ({
  inputTokens: t.inputTokens + (u.inputTokens || 0),
  outputTokens: t.outputTokens + (u.outputTokens || 0),
  cacheReadTokens: t.cacheReadTokens + (u.cacheReadTokens || 0),
  cacheWriteTokens: t.cacheWriteTokens + (u.cacheWriteTokens || 0),
  requests: t.requests + 1,
});

/** Adds one API response's reported usage to the provider and model totals. */
export async function addUsage(provider: Provider, model: string, usage: Usage): Promise<void> {
  const cur = await getUsage();
  const prevModel = cur.byModel[model];
  const next: UsageStats = {
    ...cur,
    since: cur.since ?? Date.now(),
    [provider]: addTo(cur[provider], usage),
    byModel: { ...cur.byModel, [model]: { provider, ...addTo(prevModel ?? emptyTotals(), usage) } },
  };
  await chrome.storage.local.set({ [USAGE_KEY]: next });
}

export async function resetUsage(): Promise<void> {
  await chrome.storage.local.remove(USAGE_KEY);
}

export const isUsageKey = (k: string) => k === USAGE_KEY;

// ---- Settings ------------------------------------------------------------

export async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  const s = (settings as Partial<Settings> | undefined) ?? {};
  const theme = s.theme === 'light' || s.theme === 'dark' ? s.theme : 'default';
  return { apiKey: s.apiKey ?? '', openaiKey: s.openaiKey ?? '', model: s.model || DEFAULT_MODEL, theme };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings });
}
