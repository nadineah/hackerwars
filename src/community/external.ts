import {
  INTEGRATION_PROTOCOL_VERSION as PROTOCOL,
  LIMITS,
  THEME_FORMAT_VERSION,
  describePathScope,
  normalizeHostname,
  supportedSite,
  validateCommunityCss,
  validatePathScope,
  versionAtLeast,
  versionHash,
  type ErrorCode,
  type ExportedDraft,
  type ExtError,
  type ExtResponse,
  type InstallState,
  type InstalledTheme,
  type PathScope,
  type ThemeVersionPayload,
} from '../../theme-core/src';
import type { Design } from '../shared/types';

/**
 * The extension's side of the website integration. It answers ONLY the six documented messages, only from the
 * configured website origins, and treats everything the website (or the theme server) says as untrusted input:
 * every field is re-validated here, the CSS is re-checked with the same parser the website used, the integrity hash
 * is recomputed, and nothing is applied until the user confirms in an extension-owned window naming the website.
 */

export interface Req {
  requestId: string;
  origin: string;
  payload: ThemeVersionPayload;
  state: InstallState;
  /** An earlier version of the same theme that is already installed. */
  installed?: { version: number; versionId: string; enabled: boolean };
  windowId?: number;
  createdAt: number;
  message?: string;
  code?: ErrorCode;
  designId?: string;
}

export interface Draft {
  origin: string;
  draft: ExportedDraft;
  createdAt: number;
}

export interface Deps {
  allowedOrigins: () => string[];
  extensionVersion: () => string;
  fetch: typeof fetch;
  now: () => number;
  randomId: () => string;
  loadRequests: () => Promise<Record<string, Req>>;
  saveRequests: (r: Record<string, Req>) => Promise<void>;
  loadDrafts: () => Promise<Record<string, Draft>>;
  saveDrafts: (d: Record<string, Draft>) => Promise<void>;
  /** Opens the confirmation window; resolves with its window id. */
  openConfirm: (requestId: string) => Promise<number | undefined>;
  closeWindow: (id: number) => Promise<void>;
  communityDesigns: () => Promise<Design[]>;
  install: (design: Design) => Promise<{ displacedIds: string[] }>;
  remove: (host: string, id: string) => Promise<void>;
  /** Open tabs on the exact hostname, with their URLs. */
  tabsOn: (hostname: string) => Promise<{ id: number; url: string }[]>;
  /** Does that tab's content script report this design as really applied right now? */
  appliedIn: (tabId: number, designId: string) => Promise<boolean>;
}

export const REQUEST_TTL_MS = 5 * 60_000;
export const DRAFT_TTL_MS = 10 * 60_000;
const RETAIN_MS = 30 * 60_000;
const MAX_PAYLOAD_BYTES = 200_000;
const UUID = /^[0-9a-f-]{36}$/;
const err = (code: ErrorCode, message: string): ExtError => ({ ok: false, code, message });

const originOf = (pattern: string): string | null => {
  try {
    const u = new URL(pattern.replace(/\/\*$/, '/'));
    return u.origin;
  } catch {
    return null;
  }
};
/** `externally_connectable.matches` patterns -> exact origins. A pattern that is not a plain origin is ignored. */
export const originsFromMatches = (matches: string[] | undefined): string[] =>
  (matches ?? []).filter((m) => /^https?:\/\/[^*/]+\/\*$/.test(m)).map((m) => originOf(m)).filter((o): o is string => !!o);

// ------------------------------------------------------------------------------------------ main entry

export async function handleExternal(raw: unknown, sender: { origin?: string; id?: string; url?: string }, deps: Deps): Promise<ExtResponse> {
  // Only web pages from the allowed origins. Other extensions have `sender.id`; they are refused.
  const origin = sender.origin ?? (sender.url ? safeOrigin(sender.url) : undefined);
  if (sender.id || !origin || !deps.allowedOrigins().includes(origin)) return err('forbidden-origin', 'This website is not allowed to talk to the extension.');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return err('bad-request', 'Malformed request.');
  const msg = raw as Record<string, unknown>;
  if (typeof msg.type !== 'string') return err('bad-request', 'Missing request type.');
  if (msg.protocol !== PROTOCOL) return err('unsupported-protocol', `This extension speaks protocol ${PROTOCOL}.`);

  switch (msg.type) {
    case 'whimsyweb:ping':
      return { ok: true, protocol: PROTOCOL, extensionVersion: deps.extensionVersion(), capabilities: ['install-theme', 'installed-list', 'draft-export'] };
    case 'whimsyweb:install':
      return install(msg, origin, deps);
    case 'whimsyweb:status':
      return status(msg, origin, deps);
    case 'whimsyweb:installed':
      return installed(origin, deps);
    case 'whimsyweb:get-draft':
      return getDraft(msg, origin, deps);
    case 'whimsyweb:uninstall':
      return uninstall(msg, origin, deps);
    default:
      return err('bad-request', 'Unknown request type.');
  }
}

const safeOrigin = (u: string): string | undefined => {
  try {
    return new URL(u).origin;
  } catch {
    return undefined;
  }
};

// ------------------------------------------------------------------------------------------ requests store

async function load(deps: Deps): Promise<Record<string, Req>> {
  const all = await deps.loadRequests();
  const now = deps.now();
  let changed = false;
  for (const [id, r] of Object.entries(all)) {
    // A confirmation nobody answered becomes "declined" rather than blocking every later install.
    if (r.state === 'awaiting-confirmation' && now - r.createdAt > REQUEST_TTL_MS) {
      all[id] = { ...r, state: 'declined', message: 'The confirmation window was not answered in time.' };
      if (r.windowId !== undefined) void deps.closeWindow(r.windowId).catch(() => undefined);
      changed = true;
    }
    if (now - r.createdAt > RETAIN_MS) {
      delete all[id];
      changed = true;
    }
  }
  if (changed) await deps.saveRequests(all);
  return all;
}

// ------------------------------------------------------------------------------------------ install

type Validated = { ok: true; payload: ThemeVersionPayload } | ExtError;

/** Everything about a payload is checked here, regardless of what the website promised. */
export async function validatePayload(raw: unknown, want: { themeId: string; versionId?: string }, extensionVersion: string): Promise<Validated> {
  if (!raw || typeof raw !== 'object') return err('invalid-theme', 'The theme data is malformed.');
  const p = raw as Partial<ThemeVersionPayload>;
  const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
  if (p.formatVersion !== THEME_FORMAT_VERSION) return err('invalid-theme', 'This theme uses a format this extension does not understand.');
  if (!str(p.themeId, 40) || p.themeId !== want.themeId) return err('invalid-theme', 'The theme does not match the request.');
  if (!str(p.versionId, 40) || (want.versionId && p.versionId !== want.versionId)) return err('invalid-theme', 'The version does not match the request.');
  if (!Number.isInteger(p.version) || (p.version as number) < 1) return err('invalid-theme', 'Bad version number.');
  if (!str(p.title, 100) || !str(p.slug, 100) || !p.creator || !str(p.creator.displayName, 100) || !str(p.creator.username, 60)) return err('invalid-theme', 'Missing theme details.');
  if (p.appearance !== 'light' && p.appearance !== 'dark' && p.appearance !== 'mixed') return err('invalid-theme', 'Bad appearance.');
  const hostname = normalizeHostname(p.hostname);
  if (!hostname || hostname !== p.hostname) return err('invalid-theme', 'Bad target website.');
  if (!supportedSite(hostname)) return err('unsupported-target', 'This website is not on the supported list.');
  if (validatePathScope(p.pathScope).length) return err('invalid-theme', 'The page scope is not valid.');
  if (typeof p.css !== 'string' || p.css.length > LIMITS.cssBytes * 2) return err('invalid-theme', 'The style sheet is too large.');
  const report = validateCommunityCss(p.css);
  if (!report.ok) return err('invalid-theme', `The style sheet failed the safety checks: ${report.errors[0]?.message ?? 'invalid'}`);
  if (!str(p.hash, 80) || (await versionHash({ hostname, pathScope: p.pathScope as PathScope, css: p.css })) !== p.hash) return err('integrity', 'The theme did not match its integrity hash.');
  if (p.minExtensionVersion && !versionAtLeast(extensionVersion, p.minExtensionVersion)) return err('too-old', `This theme needs extension version ${p.minExtensionVersion} or newer.`);
  return { ok: true, payload: p as ThemeVersionPayload };
}

async function fetchPayload(origin: string, themeId: string, versionId: string | undefined, deps: Deps): Promise<{ ok: true; json: unknown } | ExtError> {
  const url = `${origin}/api/v1/themes/${themeId}${versionId ? `?version=${versionId}` : ''}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await deps.fetch(url, { credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (res.status === 404) return err('unavailable', 'This theme is no longer available.');
    if (!res.ok) return err('network', `The theme server answered ${res.status}.`);
    const text = await res.text();
    if (text.length > MAX_PAYLOAD_BYTES) return err('invalid-theme', 'The theme is unexpectedly large.');
    try {
      return { ok: true, json: JSON.parse(text) };
    } catch {
      return err('invalid-theme', 'The theme server sent something that is not JSON.');
    }
  } catch {
    return err('network', 'Could not download the theme.');
  } finally {
    clearTimeout(timer);
  }
}

async function install(msg: Record<string, unknown>, origin: string, deps: Deps): Promise<ExtResponse> {
  if (typeof msg.themeId !== 'string' || !UUID.test(msg.themeId)) return err('bad-request', 'Bad theme id.');
  if (msg.versionId !== undefined && (typeof msg.versionId !== 'string' || !UUID.test(msg.versionId))) return err('bad-request', 'Bad version id.');
  const reqs = await load(deps);
  if (Object.values(reqs).some((r) => r.state === 'awaiting-confirmation')) return err('busy', 'Another theme is waiting for your confirmation.');

  const got = await fetchPayload(origin, msg.themeId, msg.versionId as string | undefined, deps);
  if (!got.ok) return got;
  const v = await validatePayload(got.json, { themeId: msg.themeId, versionId: msg.versionId as string | undefined }, deps.extensionVersion());
  if (!v.ok) return v;
  const payload = v.payload;

  const mine = (await deps.communityDesigns()).find((d) => d.community?.themeId === payload.themeId && d.community.origin === origin);
  const requestId = deps.randomId();
  const base: Req = { requestId, origin, payload, state: 'awaiting-confirmation', createdAt: deps.now(), ...(mine ? { installed: { version: mine.community!.version, versionId: mine.community!.versionId, enabled: mine.enabled } } : {}) };

  // The exact same version is already installed and switched on: nothing to confirm, and nothing to claim falsely.
  if (mine?.enabled && mine.community!.versionId === payload.versionId) {
    reqs[requestId] = { ...base, state: 'applied', designId: mine.id, message: 'This version was already installed and is active.' };
    await deps.saveRequests(reqs);
    return { ok: true, requestId };
  }

  reqs[requestId] = base;
  await deps.saveRequests(reqs);
  try {
    const windowId = await deps.openConfirm(requestId);
    reqs[requestId] = { ...base, windowId };
    await deps.saveRequests(reqs);
  } catch {
    delete reqs[requestId];
    await deps.saveRequests(reqs);
    return err('failed', 'The extension could not open its confirmation window.');
  }
  return { ok: true, requestId };
}

async function status(msg: Record<string, unknown>, origin: string, deps: Deps): Promise<ExtResponse> {
  if (typeof msg.requestId !== 'string') return err('bad-request', 'Bad request id.');
  const r = (await load(deps))[msg.requestId];
  if (!r || r.origin !== origin) return err('not-found', 'Unknown request.');
  let activeOnOpenTab: boolean | undefined;
  if (r.state === 'applied' && r.designId) {
    const tabs = await deps.tabsOn(r.payload.hostname);
    const checks = await Promise.all(tabs.map(async (t) => deps.appliedIn(t.id, r.designId!).catch(() => false)));
    activeOnOpenTab = checks.some(Boolean);
  }
  return { ok: true, requestId: r.requestId, state: r.state, themeId: r.payload.themeId, version: r.payload.version, hostname: r.payload.hostname, activeOnOpenTab, message: r.message, code: r.code };
}

async function installed(origin: string, deps: Deps): Promise<ExtResponse> {
  const themes: InstalledTheme[] = (await deps.communityDesigns())
    .filter((d) => d.community?.origin === origin)
    .map((d) => ({ themeId: d.community!.themeId, versionId: d.community!.versionId, version: d.community!.version, hostname: d.host, enabled: d.enabled, title: d.name }));
  return { ok: true, themes };
}

async function uninstall(msg: Record<string, unknown>, origin: string, deps: Deps): Promise<ExtResponse> {
  if (typeof msg.themeId !== 'string' || !UUID.test(msg.themeId)) return err('bad-request', 'Bad theme id.');
  const d = (await deps.communityDesigns()).find((x) => x.community?.themeId === msg.themeId && x.community?.origin === origin);
  if (!d) return err('not-found', 'That theme is not installed.');
  await deps.remove(d.host, d.id);
  return { ok: true };
}

async function getDraft(msg: Record<string, unknown>, origin: string, deps: Deps): Promise<ExtResponse> {
  if (typeof msg.draftId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(msg.draftId)) return err('bad-request', 'Bad draft id.');
  const drafts = await deps.loadDrafts();
  const d = drafts[msg.draftId];
  const now = deps.now();
  // One-time: it is deleted the moment it is read (or when it has expired), and only the intended website may read it.
  if (d) {
    delete drafts[msg.draftId];
    await deps.saveDrafts(drafts);
  }
  if (!d || d.origin !== origin || now - d.createdAt > DRAFT_TTL_MS) return err('not-found', 'That export has expired or was already used.');
  return { ok: true, draft: d.draft };
}

// ------------------------------------------------------------------------------------------ confirmation window

export interface ConfirmSummary {
  requestId: string;
  title: string;
  creator: string;
  siteName: string;
  hostname: string;
  scope: string;
  version: number;
  origin: string;
  license: string;
  cssBytes: number;
  update: { from: number } | null;
  reenable: boolean;
  willReplace: string[];
}

export async function summary(requestId: string, deps: Deps): Promise<ConfirmSummary | null> {
  const r = (await load(deps))[requestId];
  if (!r || r.state !== 'awaiting-confirmation') return null;
  const p = r.payload;
  return {
    requestId,
    title: p.title,
    creator: p.creator.displayName,
    siteName: supportedSite(p.hostname)?.name ?? p.hostname,
    hostname: p.hostname,
    scope: describePathScope(p.pathScope),
    version: p.version,
    origin: r.origin,
    license: p.license,
    cssBytes: p.css.length,
    update: r.installed && r.installed.version !== p.version ? { from: r.installed.version } : null,
    reenable: !!r.installed && r.installed.versionId === p.versionId && !r.installed.enabled,
    willReplace: [],
  };
}

/** Called by the confirmation window. Only then is anything stored or applied. */
export async function decide(requestId: string, approve: boolean, deps: Deps): Promise<{ ok: boolean; message?: string }> {
  const reqs = await load(deps);
  const r = reqs[requestId];
  if (!r || r.state !== 'awaiting-confirmation') return { ok: false, message: 'This request is no longer waiting.' };
  if (!approve) {
    reqs[requestId] = { ...r, state: 'declined', code: 'declined', message: 'You declined the request.' };
    await deps.saveRequests(reqs);
    return { ok: true };
  }
  const p = r.payload;
  const now = deps.now();
  const design: Design = {
    id: deps.randomId(),
    host: p.hostname,
    scope: 'site',
    name: p.title,
    prompt: '',
    css: p.css,
    ops: [],
    enabled: true,
    createdAt: now,
    updatedAt: now,
    community: { themeId: p.themeId, versionId: p.versionId, version: p.version, slug: p.slug, hash: p.hash, creator: p.creator.displayName, pathScope: p.pathScope, displacedIds: [], origin: r.origin, installedAt: now },
  };
  try {
    const out = await deps.install(design);
    const stored = (await deps.communityDesigns()).find((d) => d.community?.themeId === p.themeId && d.community.origin === r.origin);
    reqs[requestId] = { ...r, state: 'applied', designId: stored?.id ?? design.id, message: out.displacedIds.length ? 'Installed. Your previous design for this site was switched off and will come back if you remove this theme.' : 'Installed.' };
  } catch {
    reqs[requestId] = { ...r, state: 'failed', code: 'failed', message: 'The extension could not save the theme.' };
  }
  await deps.saveRequests(reqs);
  return { ok: reqs[requestId].state === 'applied', message: reqs[requestId].message };
}

/** The confirmation window was closed without an answer. */
export async function windowClosed(windowId: number, deps: Deps): Promise<void> {
  const reqs = await load(deps);
  let changed = false;
  for (const [id, r] of Object.entries(reqs)) {
    if (r.windowId === windowId && r.state === 'awaiting-confirmation') {
      reqs[id] = { ...r, state: 'declined', code: 'declined', message: 'The confirmation window was closed.' };
      changed = true;
    }
  }
  if (changed) await deps.saveRequests(reqs);
}

// ------------------------------------------------------------------------------------------ draft export

/** Stores a one-time export for the website's publishing flow and returns its id. */
export async function createDraft(draft: ExportedDraft, origin: string, deps: Deps): Promise<string> {
  const drafts = await deps.loadDrafts();
  const now = deps.now();
  for (const [id, d] of Object.entries(drafts)) if (now - d.createdAt > DRAFT_TTL_MS) delete drafts[id];
  const id = `${deps.randomId().replace(/-/g, '')}${deps.randomId().replace(/-/g, '')}`.slice(0, 40);
  drafts[id] = { origin, draft, createdAt: now };
  await deps.saveDrafts(drafts);
  return id;
}
