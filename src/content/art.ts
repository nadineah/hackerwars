import { artKey, isArtRecord, resolveArtTokens, tokensIn } from '../shared/art';
import type { Design } from '../shared/types';

/**
 * Generated illustrations are stored once by the extension; designs only carry a short token. Before designs are
 * applied, the pictures they need are read (by exact key, only for tokens that appear in the design) and kept here,
 * so the token can be swapped for the image when the stylesheet is built, after it has been sanitized.
 */
const cache = new Map<string, string>();

export async function loadArt(designs: Design[]): Promise<void> {
  const need = new Set<string>();
  for (const d of designs) for (const t of tokensIn(`${d.css}\n${JSON.stringify(d.ops)}`)) if (!cache.has(t)) need.add(t);
  if (!need.size) return;
  try {
    const keys = [...need].map(artKey);
    const got = await chrome.storage.local.get(keys);
    for (const t of need) {
      const rec = got[artKey(t)];
      if (isArtRecord(rec)) cache.set(t, rec.data);
    }
  } catch {
    /* storage unavailable: the design still applies, just without its pictures */
  }
}

/** Swaps stored-picture tokens in already-sanitized text for the real images (unknown ones become a blank pixel). */
export const withArt = (text: string): string => resolveArtTokens(text, cache);
