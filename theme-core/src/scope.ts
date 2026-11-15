import { LIMITS, type PathScope } from './format';

/**
 * Hostname + path matching for community themes. A theme names ONE exact hostname (no wildcards, no
 * subdomain matching) and a structured path scope. Used by the website to validate what a creator
 * declares and by the extension to decide where a theme may apply.
 */

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Lowercases and trims; returns null if it is not a plain DNS hostname (IPs, ports, wildcards, schemes...). */
export function normalizeHostname(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const h = input.trim().toLowerCase().replace(/\.$/, '');
  return HOSTNAME_RE.test(h) ? h : null;
}

/** "/a/b/" and "/a/b" are the same; query string and hash are not part of a path. */
export function normalizePath(p: string): string {
  const path = p.split(/[?#]/)[0] || '/';
  return path.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
}

/**
 * Pages that must never be restyled by community themes: sign-in, account security and payment flows.
 * A theme that hides or mimics fields there could mislead someone into handing over credentials.
 * Applies to every theme regardless of its declared scope.
 */
const SENSITIVE_SEGMENT = /^(login|log-in|logon|signin|sign-in|signup|sign-up|register|auth|oauth|oauth2|sso|saml|password|passwords|reset|recover|recovery|2fa|mfa|otp|verify|verification|security|checkout|payment|payments|billing|pay|wallet|account-security|sessions?)$/i;
export function isSensitivePath(path: string): boolean {
  return normalizePath(path)
    .split('/')
    .some((seg) => SENSITIVE_SEGMENT.test(seg));
}

export interface PathScopeIssue {
  field: string;
  message: string;
}

/** Validates a declared scope. Returns a list of problems (empty = valid). */
export function validatePathScope(scope: unknown): PathScopeIssue[] {
  const issues: PathScopeIssue[] = [];
  if (!scope || typeof scope !== 'object') return [{ field: 'pathScope', message: 'Choose which pages the theme applies to.' }];
  const s = scope as { mode?: unknown; paths?: unknown };
  if (s.mode === 'all') {
    if (s.paths !== undefined) issues.push({ field: 'pathScope', message: '"All pages" takes no path list.' });
    return issues;
  }
  if (s.mode !== 'prefix' && s.mode !== 'exact') return [{ field: 'pathScope', message: 'Unknown page scope.' }];
  if (!Array.isArray(s.paths) || s.paths.length === 0) return [{ field: 'pathScope', message: 'Add at least one path.' }];
  if (s.paths.length > LIMITS.pathScopePaths) issues.push({ field: 'pathScope', message: `At most ${LIMITS.pathScopePaths} paths.` });
  for (const p of s.paths) {
    if (typeof p !== 'string' || !p.startsWith('/') || p.length > LIMITS.pathLength) {
      issues.push({ field: 'pathScope', message: `Paths must start with "/" and be under ${LIMITS.pathLength} characters.` });
    } else if (/[?#*\s\\]|\.\.|\/\//.test(p)) {
      issues.push({ field: 'pathScope', message: `"${p}" may not contain wildcards, queries, spaces, "//" or "..".` });
    } else if (isSensitivePath(p)) {
      issues.push({ field: 'pathScope', message: `"${p}" is a sign-in, security or payment page; themes cannot target those.` });
    }
  }
  return issues;
}

/** Does `path` fall inside the scope? (Sensitive paths never match.) */
export function pathInScope(path: string, scope: PathScope): boolean {
  const p = normalizePath(path);
  if (isSensitivePath(p)) return false;
  if (scope.mode === 'all') return true;
  const paths = scope.paths.map(normalizePath);
  if (scope.mode === 'exact') return paths.includes(p);
  return paths.some((base) => base === '/' || p === base || p.startsWith(base + '/'));
}

/** Should a theme for (hostname, pathScope) apply to this URL? Exact hostname, http(s) only. */
export function urlInScope(url: string | URL, target: { hostname: string; pathScope: PathScope }): boolean {
  let u: URL;
  try {
    u = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.port && u.port !== '80' && u.port !== '443') return false;
  if (u.hostname.toLowerCase() !== target.hostname) return false;
  return pathInScope(u.pathname, target.pathScope);
}

export function describePathScope(scope: PathScope): string {
  if (scope.mode === 'all') return 'All pages';
  const list = scope.paths.join(', ');
  return scope.mode === 'exact' ? `Only ${list}` : `${list} and below`;
}
