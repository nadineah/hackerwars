import { THEME_FORMAT_VERSION, type PathScope } from './format';

/** Canonical, order-independent form of the parts that define what a version does. */
export function canonicalVersionString(v: { hostname: string; pathScope: PathScope; css: string; formatVersion?: number }): string {
  const scope =
    v.pathScope.mode === 'all'
      ? ['all']
      : [v.pathScope.mode, ...[...v.pathScope.paths].sort()];
  return JSON.stringify([v.formatVersion ?? THEME_FORMAT_VERSION, v.hostname, scope, v.css]);
}

/** SHA-256 as lowercase hex. WebCrypto is available in Node 20+, browsers and extension service workers. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export const versionHash = (v: { hostname: string; pathScope: PathScope; css: string; formatVersion?: number }): Promise<string> =>
  sha256Hex(canonicalVersionString(v));
