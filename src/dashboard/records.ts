import type { RawItem } from './extract';
import { identityOf } from './extract';
import { LIMITS, type DashRecord, type Source } from './schema';
import { hashHex, stableStringify } from './util';

/** Raw extracted items -> normalized records. Stable ids, attribution, and dedupe within a source. */
export function normalize(src: Pick<Source, 'id' | 'name' | 'url'>, items: RawItem[], now: number, previous: DashRecord[] = []): DashRecord[] {
  const firstSeen = new Map(previous.map((r) => [r.id, r.collectedAt]));
  const seen = new Set<string>();
  const out: DashRecord[] = [];
  for (const it of items) {
    const id = `r_${hashHex(`${src.id}|${identityOf(it, src.url)}`).slice(0, 20)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      sourceId: src.id,
      sourceName: src.name,
      title: it.title,
      ...(it.url ? { url: it.url } : {}),
      ...(it.summary ? { summary: it.summary } : {}),
      ...(it.image ? { image: it.image } : {}),
      ...(it.publishedAt !== undefined ? { publishedAt: it.publishedAt } : {}),
      collectedAt: firstSeen.get(id) ?? now,
    });
  }
  return out.slice(0, LIMITS.maxItems);
}

/** Hash of what a user would SEE; collection time is excluded so an unchanged page never counts as a change. */
export function contentHash(records: DashRecord[]): string {
  return hashHex(stableStringify(records.map(({ id, title, url, summary, image, publishedAt }) => ({ id, title, url, summary, image, publishedAt }))));
}

/** Newest first. Items with a real publication date sort by it; items without one sort by when we first saw them. */
export function sortRecords(records: DashRecord[], by: 'published' | 'collected' = 'published'): DashRecord[] {
  const key = (r: DashRecord) => (by === 'published' ? (r.publishedAt ?? r.collectedAt) : r.collectedAt);
  return records.slice().sort((a, b) => key(b) - key(a) || a.title.localeCompare(b.title));
}

/** Combine several sources' records: filter by keyword, drop duplicates of the same canonical URL, sort, limit. */
export function combine(lists: DashRecord[][], opts: { keyword?: string; sort?: 'published' | 'collected'; limit: number }): DashRecord[] {
  const kw = opts.keyword?.toLowerCase();
  const seen = new Set<string>();
  const merged: DashRecord[] = [];
  for (const r of sortRecords(lists.flat(), opts.sort)) {
    if (kw && !`${r.title} ${r.summary ?? ''}`.toLowerCase().includes(kw)) continue;
    const dupeKey = r.url ? `u:${r.url.replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase()}` : `i:${r.id}`;
    if (seen.has(dupeKey)) continue;
    seen.add(dupeKey);
    merged.push(r);
    if (merged.length >= opts.limit) break;
  }
  return merged;
}
