/**
 * Which children of one element the Edit Mode tree shows. Long lists load lazily, a batch at a time:
 *  - "Show more" / "Show earlier" grow the loaded range by one batch.
 *  - An element picked on the page that is outside the range is brought in: loaded up to it when it is near the
 *    top of the list, or as a small window around it when it is far down (no need to load 2,000 rows to show one).
 *  - A refresh (the list changed on the page) keeps the range, so the tree does not snap back to the first batch.
 */
export const TREE_BATCH = 150;
/** Up to this position, a picked element is reached by loading the list from the top; further down, a window. */
export const TREE_FROM_TOP = 500;
const WINDOW_BEFORE = 50;
const WINDOW_AFTER = 100;

export interface ChildRange {
  start: number;
  end: number;
}

/**
 * The range to load. `cur`: what the panel has loaded (none yet: the first batch). `reveal`: the position of a child
 * that must be included (-1 or undefined: none). The result is clamped to `total`.
 */
export function childRange(total: number, cur?: Partial<ChildRange>, reveal?: number): ChildRange {
  const clamp = (r: ChildRange): ChildRange => {
    // a list that shrank below the loaded window shows its last batch rather than nothing
    const start = r.start >= total ? Math.max(0, total - TREE_BATCH) : Math.max(0, r.start);
    return { start, end: Math.max(start, Math.min(r.end, total)) };
  };
  const start0 = Number.isFinite(cur?.start) ? Math.max(0, Math.floor(cur!.start!)) : 0;
  const end0 = Number.isFinite(cur?.end) ? Math.max(start0, Math.floor(cur!.end!)) : start0 + TREE_BATCH;
  let r = { start: start0, end: Math.max(end0, Math.min(start0 + TREE_BATCH, total)) };
  if (reveal !== undefined && reveal >= 0 && reveal < total && !(reveal >= r.start && reveal < r.end)) {
    if (reveal < TREE_FROM_TOP) {
      // load from the top down to it (and a little past it), keeping what was already loaded from the top
      const upTo = Math.ceil((reveal + 1) / TREE_BATCH) * TREE_BATCH;
      r = { start: 0, end: Math.max(r.start === 0 ? r.end : 0, upTo, TREE_BATCH) };
    } else {
      r = { start: reveal - WINDOW_BEFORE, end: reveal + WINDOW_AFTER };
    }
  }
  return clamp(r);
}
