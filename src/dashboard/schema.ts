import { isPrivateHost, cleanText } from './util';

/**
 * Dashboard mode, version 2. A dashboard is a small web page the assistant writes (HTML, CSS and JavaScript), plus
 * an optional "collect" script that pulls data from websites. Both kinds of script run only inside a sandboxed
 * extension page (no extension APIs, no cookies, no network of their own). The ONLY way they reach the outside is
 * the bridge in bridge.ts, which refuses anything outside the sites the user approved.
 */
export const SCHEMA_VERSION = 2;

export const LIMITS = {
  dashboards: 30,
  nameChars: 60,
  htmlChars: 60_000,
  cssChars: 60_000,
  jsChars: 60_000,
  collectChars: 40_000,
  /** Largest data object a collect script may return. */
  dataBytes: 1_000_000,
  domains: 10,
  storeBytes: 200_000,
  fetchBytes: 2_500_000,
} as const;

export const INTERVAL = { min: 10, minRendered: 30, default: 30, defaultRendered: 60, max: 1440 } as const;
/** Time a collect run may take (all fetches and the script together). */
export const COLLECT_TIMEOUT_MS = 90_000;
export const FETCH_TIMEOUT_MS = 20_000;
export const RENDER_TIMEOUT_MS = 45_000;

export interface Approval {
  approvedAt: number;
  /** Hostnames the scripts may read (www and bare host count as one). */
  domains: string[];
  /** Whether a managed, inactive background tab may be opened to read pages that need JavaScript or sign-in. */
  backgroundTabs: boolean;
  intervalMinutes: number;
  /** Always true: collected data stays in this browser. */
  dataLocalOnly: true;
}

export interface Dashboard {
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  paused: boolean;
  html: string;
  css: string;
  /** Runs in the sandboxed page. Gets `ww` (see sandbox.ts). */
  js: string;
  /** Body of an async function `collect(ww)` that returns the data the page shows. Empty = nothing to collect. */
  collect: string;
  intervalMinutes: number;
  /** Sites the scripts want to read. Nothing runs against a site until the user approves it. */
  domains: string[];
  backgroundTabs: boolean;
  approval: Approval | null;
}

export type DashStatus = 'idle' | 'running' | 'ok' | 'paused' | 'needs-approval' | 'needs-signin' | 'needs-attention' | 'error';

export interface DashState {
  dashboardId: string;
  status: DashStatus;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastChangeAt?: number;
  nextCheckAt: number;
  lastError?: string;
  errorCode?: string;
  consecutiveFailures: number;
  contentHash?: string;
  backoffUntil?: number;
  runningSince?: number;
  runId?: string;
}

/** What the last successful collect returned. */
export interface DashData {
  value: unknown;
  at: number;
  bytes: number;
}

export interface JobResult {
  at: number;
  dashboardId: string;
  name: string;
  ok: boolean;
  outcome: string;
  ms: number;
}

// ------------------------------------------------------------------------------------------ domains

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const bareHost = (h: string): string => h.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');

/** A plain public hostname (no scheme, port, path, wildcard, IP or private/local name), or null. */
export function normalizeDomain(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const h = bareHost(input.trim());
  return HOST_RE.test(h) && !isPrivateHost(h) ? h : null;
}

export const hostAllowed = (approved: string[], hostname: string): boolean => approved.includes(bareHost(hostname));

export function approvalFor(d: Pick<Dashboard, 'domains' | 'backgroundTabs' | 'intervalMinutes'>, now = Date.now()): Approval {
  return { approvedAt: now, domains: [...d.domains], backgroundTabs: d.backgroundTabs, intervalMinutes: d.intervalMinutes, dataLocalOnly: true };
}

/** An approval covers the dashboard only while it asks for no more than was approved. A new site or background tabs needs a new approval. */
export function approvalCovers(a: Approval | null, d: Pick<Dashboard, 'domains' | 'backgroundTabs'>): boolean {
  return !!a && d.domains.every((h) => a.domains.includes(h)) && (!d.backgroundTabs || a.backgroundTabs);
}

/** Sites the dashboard asks for that the user has not approved yet. */
export const unapprovedDomains = (d: Pick<Dashboard, 'domains' | 'approval'>): string[] => d.domains.filter((h) => !d.approval?.domains.includes(h));

export const minInterval = (d: Pick<Dashboard, 'backgroundTabs'>): number => (d.backgroundTabs ? INTERVAL.minRendered : INTERVAL.min);

// ------------------------------------------------------------------------------------------ validation

export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export interface CodeInput {
  name?: unknown;
  html?: unknown;
  css?: unknown;
  js?: unknown;
  collect?: unknown;
  domains?: unknown;
  intervalMinutes?: unknown;
  backgroundTabs?: unknown;
}

/**
 * Checks the parts a model (or a hand edit) may set. Code is stored as text and only ever run in the sandbox, so
 * validation is about size, type and the sites it asks for, never about trying to "understand" the code.
 */
export function validateCode(raw: CodeInput, current: Pick<Dashboard, 'intervalMinutes' | 'backgroundTabs'>): Result<Pick<Dashboard, 'html' | 'css' | 'js' | 'collect' | 'domains' | 'intervalMinutes' | 'backgroundTabs'> & { name?: string }> {
  const errors: string[] = [];
  const text = (v: unknown, key: string, max: number): string => {
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string') {
      errors.push(`${key}: must be text`);
      return '';
    }
    if (v.length > max) errors.push(`${key}: too long (${v.length} characters, the limit is ${max})`);
    return v.slice(0, max);
  };
  const html = text(raw.html, 'html', LIMITS.htmlChars);
  const css = text(raw.css, 'css', LIMITS.cssChars);
  const js = text(raw.js, 'js', LIMITS.jsChars);
  const collect = text(raw.collect, 'collect', LIMITS.collectChars);
  const domains: string[] = [];
  for (const d of Array.isArray(raw.domains) ? raw.domains : []) {
    const n = normalizeDomain(d);
    if (!n) errors.push(`domains: "${String(d).slice(0, 60)}" is not a public website name (use just the host, like example.com)`);
    else if (!domains.includes(n)) domains.push(n);
  }
  if (domains.length > LIMITS.domains) errors.push(`domains: at most ${LIMITS.domains} sites`);
  const backgroundTabs = raw.backgroundTabs === undefined ? current.backgroundTabs : raw.backgroundTabs === true;
  const min = backgroundTabs ? INTERVAL.minRendered : INTERVAL.min;
  let intervalMinutes = current.intervalMinutes;
  if (raw.intervalMinutes !== undefined) {
    const n = raw.intervalMinutes;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > INTERVAL.max) errors.push(`intervalMinutes: must be a whole number between ${min} and ${INTERVAL.max}`);
    else intervalMinutes = n;
  }
  if (intervalMinutes < min) intervalMinutes = min;
  const name = typeof raw.name === 'string' ? cleanText(raw.name, LIMITS.nameChars) : undefined;
  return errors.length ? { ok: false, errors } : { ok: true, value: { html, css, js, collect, domains, intervalMinutes, backgroundTabs, ...(name ? { name } : {}) } };
}

export function newDashboard(id: string, name = 'Untitled dashboard', now = Date.now()): Dashboard {
  return { schemaVersion: SCHEMA_VERSION, id, name, createdAt: now, updatedAt: now, paused: false, html: '', css: '', js: '', collect: '', intervalMinutes: INTERVAL.default, domains: [], backgroundTabs: false, approval: null };
}

/** Repairs whatever is in storage (including version 1 widget dashboards, which keep only their name) into a valid dashboard. */
export function repairDashboard(raw: unknown): Dashboard | null {
  if (!isObj(raw)) return null;
  const id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{4,40}$/.test(raw.id) ? raw.id : null;
  if (!id) return null;
  const base = newDashboard(id, cleanText(typeof raw.name === 'string' ? raw.name : '', LIMITS.nameChars) || 'Untitled dashboard', typeof raw.createdAt === 'number' ? raw.createdAt : Date.now());
  const v2 = raw.schemaVersion === SCHEMA_VERSION;
  if (!v2) return base;
  const code = validateCode({ ...raw, html: String(raw.html ?? '').slice(0, LIMITS.htmlChars), css: String(raw.css ?? '').slice(0, LIMITS.cssChars), js: String(raw.js ?? '').slice(0, LIMITS.jsChars), collect: String(raw.collect ?? '').slice(0, LIMITS.collectChars), domains: (Array.isArray(raw.domains) ? raw.domains : []).map(normalizeDomain).filter((x): x is string => !!x).slice(0, LIMITS.domains), intervalMinutes: undefined }, base);
  const c = code.ok ? code.value : { html: '', css: '', js: '', collect: '', domains: [], intervalMinutes: base.intervalMinutes, backgroundTabs: false };
  const a = raw.approval;
  const approval: Approval | null =
    isObj(a) && Array.isArray(a.domains) ? { approvedAt: Number(a.approvedAt) || Date.now(), domains: a.domains.map(normalizeDomain).filter((x): x is string => !!x), backgroundTabs: a.backgroundTabs === true, intervalMinutes: Number(a.intervalMinutes) || base.intervalMinutes, dataLocalOnly: true } : null;
  const interval = typeof raw.intervalMinutes === 'number' && Number.isInteger(raw.intervalMinutes) && raw.intervalMinutes >= minInterval(c) && raw.intervalMinutes <= INTERVAL.max ? raw.intervalMinutes : Math.max(base.intervalMinutes, minInterval(c));
  return { ...base, updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : base.updatedAt, paused: raw.paused === true, ...c, intervalMinutes: interval, approval };
}
