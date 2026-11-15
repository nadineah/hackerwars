import { INTEGRATION_PROTOCOL_VERSION, type Appearance, type PathScope } from './format';

/**
 * The ONLY messages the website may send the extension (chrome.runtime.sendMessage with the extension id,
 * allowed by the manifest's "externally_connectable" for the website's origins). The extension validates
 * the sender's origin and every field; anything unlisted is rejected. There is no way to run code,
 * read page contents, read other storage or change arbitrary settings through this channel.
 */
export const PROTOCOL = INTEGRATION_PROTOCOL_VERSION;

export type ExtCapability = 'install-theme' | 'installed-list' | 'draft-export';

export type PingRequest = { type: 'whimsyweb:ping'; protocol: number };
export type InstallRequest = {
  type: 'whimsyweb:install';
  protocol: number;
  themeId: string;
  /** Pin an exact version (the one the visitor was looking at). Omit for "current". */
  versionId?: string;
};
export type StatusRequest = { type: 'whimsyweb:status'; protocol: number; requestId: string };
export type InstalledRequest = { type: 'whimsyweb:installed'; protocol: number };
export type GetDraftRequest = { type: 'whimsyweb:get-draft'; protocol: number; draftId: string };
export type UninstallRequest = { type: 'whimsyweb:uninstall'; protocol: number; themeId: string };

export type ExtRequest = PingRequest | InstallRequest | StatusRequest | InstalledRequest | GetDraftRequest | UninstallRequest;

export type ErrorCode =
  | 'bad-request'
  | 'unsupported-protocol'
  | 'forbidden-origin'
  | 'not-found'
  | 'unavailable' // unpublished / moderated / removed
  | 'invalid-theme' // failed validation inside the extension
  | 'integrity' // hash mismatch
  | 'too-old' // extension older than the theme requires
  | 'network'
  | 'unsupported-target' // site not in the curated list
  | 'busy'
  | 'declined'
  | 'failed';

export type ExtError = { ok: false; code: ErrorCode; message: string };

export type PingResponse = { ok: true; protocol: number; extensionVersion: string; capabilities: ExtCapability[] };
export type InstallResponse = { ok: true; requestId: string };

/**
 * Lifecycle of an install request. "applied" is only reported once the extension has really stored the
 * theme and switched it on; the website must never claim success before that.
 */
export type InstallState = 'awaiting-confirmation' | 'applied' | 'declined' | 'failed';
export type StatusResponse = {
  ok: true;
  requestId: string;
  state: InstallState;
  themeId: string;
  version?: number;
  hostname?: string;
  /** True when a tab on the target site is open and the theme is active there right now. */
  activeOnOpenTab?: boolean;
  message?: string;
  code?: ErrorCode;
};

export interface InstalledTheme {
  themeId: string;
  versionId: string;
  version: number;
  hostname: string;
  enabled: boolean;
  title: string;
}
export type InstalledResponse = { ok: true; themes: InstalledTheme[] };
export type UninstallResponse = { ok: true };

/** A theme exported from the extension for publishing on the website. Structured data, never a URL parameter. */
export interface ExportedDraft {
  title: string;
  hostname: string;
  pathScope: PathScope;
  css: string;
  appearance?: Appearance;
}
export type GetDraftResponse = { ok: true; draft: ExportedDraft };

export type ExtResponse = PingResponse | InstallResponse | StatusResponse | InstalledResponse | GetDraftResponse | UninstallResponse | ExtError;

export const isExtError = (r: unknown): r is ExtError => !!r && typeof r === 'object' && (r as { ok?: unknown }).ok === false;

/** Compare dotted extension versions ("0.2.0" < "0.10.0"). */
export function versionAtLeast(have: string, need: string): boolean {
  const a = have.split('.').map((n) => parseInt(n, 10) || 0);
  const b = need.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}
