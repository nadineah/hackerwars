/** Small, dependency-free helpers shared by the service worker, offscreen parser, content script and UI. */

/** A fast, well-mixed 53-bit string hash (cyrb53). Two seeds give ~106 bits: plenty for ids and change detection. */
export function hash53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** 26 hex chars of stable hash for ids and change detection (not for security). */
export function hashHex(str: string): string {
  return hash53(str, 0).toString(16).padStart(14, '0') + hash53(str, 7).toString(16).padStart(14, '0').slice(0, 12);
}

export const newId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

/** Stable JSON: object keys sorted, so equal configs always hash equal. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

// ------------------------------------------------------------------------------------------ URLs

/** Hosts that must never be fetched: this machine, the local network, and link-local/metadata addresses. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home.arpa') || h.endsWith('.intranet')) return true;
  if (!h.includes('.') && !h.includes(':')) return true; // single-label names resolve on the local network
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || a === 0 || a >= 224 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(':')) return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:');
  return false;
}

export interface UrlCheck {
  ok: boolean;
  url?: URL;
  reason?: string;
}

/**
 * The one gate every collection URL passes. http(s) only, no embedded credentials, no unusual ports, and (unless a
 * developer override is on) never a private or local address, so a manipulated configuration cannot be used to
 * probe the user's own network.
 */
export function checkCollectionUrl(input: unknown, opts: { allowLocal?: boolean } = {}): UrlCheck {
  if (typeof input !== 'string' || input.length > 2000) return { ok: false, reason: 'Enter a web address (up to 2000 characters).' };
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return { ok: false, reason: 'That is not a valid web address.' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'Only http and https addresses can be used.' };
  if (u.username || u.password) return { ok: false, reason: 'Addresses with a username or password are not allowed.' };
  if (!opts.allowLocal) {
    if (isPrivateHost(u.hostname)) return { ok: false, reason: 'Private, local-network and localhost addresses are not allowed.' };
    if (u.port && u.port !== '80' && u.port !== '443') return { ok: false, reason: 'Only the standard web ports are allowed.' };
  }
  return { ok: true, url: u };
}

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|igshid|spm)$/i;

/** A URL normalized for identity comparisons: lowercase host, no fragment, no tracking params, no trailing slash. */
export function canonicalUrl(input: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(input, base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  let s = u.toString();
  if (u.pathname !== '/' && s.endsWith('/') && !u.search) s = s.slice(0, -1);
  return s;
}

/** Resolves a possibly relative link against a base and keeps it only if it is a plain http(s) URL. */
export function safeLink(href: string | null | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try {
    const u = new URL(href.trim(), base);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

/** `www.` and bare host are the same site for redirect purposes; anything else is a different host. */
export const sameSiteHost = (a: string, b: string): boolean => a.replace(/^www\./, '').toLowerCase() === b.replace(/^www\./, '').toLowerCase();

// ------------------------------------------------------------------------------------------ text / time

export function cleanText(s: string | null | undefined, max: number): string {
  if (!s) return '';
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Parses a date string and returns epoch ms, or undefined when it is missing or not a real date. NEVER invents one. */
export function parseDate(s: string | null | undefined): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(s.trim());
  if (!Number.isFinite(t)) return undefined;
  const now = Date.now();
  if (t < Date.UTC(1990, 0, 1) || t > now + 36 * 3600_000) return undefined; // implausible: ignore rather than display
  return t;
}

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

export function inFuture(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((ms - now) / 1000));
  if (s < 60) return 'in under a minute';
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 60);
  return h < 24 ? `in ${h} hour${h === 1 ? '' : 's'}` : `in ${Math.round(h / 24)} days`;
}
