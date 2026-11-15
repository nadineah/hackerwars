/**
 * WhimsyWeb theme format, shared by the website and the browser extension.
 *
 * A THEME is an identity (owner, slug, tags...). Each published VERSION of it is immutable and carries
 * the CSS plus exactly where it may apply. The extension only ever installs a specific version, and only
 * after re-validating it, so an update by the creator never silently changes an installed theme.
 */

/** Bump when the shape or policy changes incompatibly; the extension refuses formats it does not know. */
export const THEME_FORMAT_VERSION = 1;

export type Appearance = 'light' | 'dark' | 'mixed';

/** Which pages of the target hostname a theme applies to. Structured, never a wildcard pattern. */
export type PathScope =
  | { mode: 'all' }
  /** Applies to each path and everything below it, at segment boundaries ("/wiki" matches "/wiki/Cat"). */
  | { mode: 'prefix'; paths: string[] }
  /** Applies to exactly these paths. */
  | { mode: 'exact'; paths: string[] };

export const LICENSES = [
  { id: 'cc0', label: 'CC0 (public domain)' },
  { id: 'cc-by-4.0', label: 'CC BY 4.0' },
  { id: 'cc-by-sa-4.0', label: 'CC BY-SA 4.0' },
  { id: 'mit', label: 'MIT' },
  { id: 'all-rights-reserved', label: 'All rights reserved (installable, not remixable)' },
] as const;
export type LicenseId = (typeof LICENSES)[number]['id'];
export const isLicenseId = (v: unknown): v is LicenseId => LICENSES.some((l) => l.id === v);

export type ThemeStatus = 'draft' | 'published' | 'unpublished';

/**
 * What the extension receives for one theme version. Everything needed to validate, display (for the
 * install confirmation) and apply it; nothing executable.
 */
export interface ThemeVersionPayload {
  formatVersion: number;
  themeId: string;
  versionId: string;
  /** 1, 2, 3... per theme. */
  version: number;
  slug: string;
  title: string;
  creator: { username: string; displayName: string };
  appearance: Appearance;
  license: LicenseId;
  hostname: string;
  pathScope: PathScope;
  css: string;
  /** Lowercase hex SHA-256 over the canonical form of (formatVersion, hostname, pathScope, css). */
  hash: string;
  /** Oldest extension that can install this version, e.g. "0.2.0". */
  minExtensionVersion?: string;
  publishedAt: string;
}

/** Limits, enforced on the website at publish time AND again by the extension before installing. */
export const LIMITS = {
  cssBytes: 60_000,
  rules: 3_000,
  declarations: 10_000,
  nestingDepth: 4,
  dataUriChars: 30_000,
  // Must stay below cssBytes, or the total could never be reached.
  dataUriTotalChars: 45_000,
  pathScopePaths: 20,
  pathLength: 200,
  titleChars: 60,
  descriptionChars: 600,
  tags: 8,
  tagChars: 24,
  changeNotesChars: 400,
} as const;

/** The messages a website may send the extension. Anything else is rejected. */
export const INTEGRATION_PROTOCOL_VERSION = 1;
