/**
 * Only same-site relative paths are accepted as "where to go after signing in". Anything else
 * (absolute URLs, protocol-relative "//evil.com", backslash tricks) falls back to the home page, so the
 * sign-in flow cannot be used as an open redirect.
 */
export function safeNext(next: unknown, fallback = '/'): string {
  if (typeof next !== 'string') return fallback;
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\') || /[\u0000-\u001f]/.test(next)) return fallback;
  try {
    const u = new URL(next, 'http://localhost');
    if (u.origin !== 'http://localhost') return fallback;
    return u.pathname + u.search + u.hash;
  } catch {
    return fallback;
  }
}
