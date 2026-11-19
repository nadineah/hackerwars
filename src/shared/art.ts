/**
 * Generated illustrations. A picture made by the image model is stored once, locally, under `art:<id>`, and designs
 * refer to it by a short token (`ww-asset-art:<id>`) instead of carrying the picture inside their CSS. The token is
 * resolved to the real image only inside the page, at apply time. A token on its own is not a web address, so it can
 * never make a network request, and only ids that exist in storage resolve to anything.
 */
export interface ArtRecord {
  /** A small `data:image/webp;base64,...` (png/jpeg also accepted). */
  data: string;
  w: number;
  h: number;
  /** What the picture shows (the model's description), so a later turn can tell what is available to reuse. */
  prompt: string;
}

export const ART_PREFIX = 'ww-asset-art:';
const ART_ID = '[a-f0-9]{12}';
const ART_TOKEN = new RegExp(`${ART_PREFIX}${ART_ID}`, 'g');
const ART_TOKEN_EXACT = new RegExp(`^${ART_PREFIX}${ART_ID}$`);

/** Most pictures one design may ask for, and the size limits of a stored picture. */
export const MAX_ART_PER_DESIGN = 4;
export const MAX_ART_DATA_CHARS = 700_000;

export const isArtToken = (s: string): boolean => ART_TOKEN_EXACT.test(s.trim());
export const artKey = (token: string): string => `art:${token.slice(ART_PREFIX.length)}`;
export const isArtKey = (k: string): boolean => /^art:[a-f0-9]{12}$/.test(k);

export const isArtDataUrl = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= MAX_ART_DATA_CHARS && /^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]{20,}$/.test(v);

export const isArtRecord = (v: unknown): v is ArtRecord => {
  const r = v as ArtRecord;
  return !!r && typeof r === 'object' && isArtDataUrl(r.data) && Number.isFinite(r.w) && Number.isFinite(r.h);
};

/** A fresh random token. Only the extension makes these: the model can never name a stored picture. */
export function newArtToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return ART_PREFIX + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Every art token mentioned in some text (CSS, or JSON of ops), without duplicates. */
export function tokensIn(text: string): string[] {
  return Array.from(new Set(text.match(ART_TOKEN) ?? []));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The model names the pictures it asks for (`ww-asset-candy-village`). Once they exist, those names become real
 * tokens. Only names that were actually generated are replaced; an unknown name is left as it is, and the CSS
 * sanitizer then removes it. Tokens that already exist (`ww-asset-art:<id>`) are never touched.
 */
export function bindArtNames(text: string, names: Map<string, string>): string {
  let out = text;
  for (const [name, token] of names) {
    out = out.replace(new RegExp(`ww-asset-${escapeRe(name)}(?![\\w:-])`, 'g'), token);
  }
  return out;
}

/** Replaces tokens with the real image data (used inside the page, after the CSS was sanitized). */
export function resolveArtTokens(text: string, lookup: ReadonlyMap<string, string>): string {
  if (!text.includes(ART_PREFIX)) return text;
  return text.replace(ART_TOKEN, (t) => lookup.get(t) ?? 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==');
}

/** A 1x1 transparent picture, standing in for artwork that cannot travel with a shared theme. */
export const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
export const stripArtTokens = (text: string): string => text.replace(ART_TOKEN, TRANSPARENT_PIXEL);
