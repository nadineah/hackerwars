/**
 * Theme corrections the live check learned on a site: "this kind of element, in this state, gets these theme
 * colours". Saved per site for the designs that were on, and loaded before anything is drawn on the next visit, so
 * a white that was corrected once is not seen again. Plain data, validated strictly (only theme colours, only simple
 * selectors) because it comes from a page script's measurements.
 */

export interface LearnedRule {
  /** tag + up to two classes, optionally :hover or :focus-within (e.g. "div.ytSearchboxComponentInputBox:focus-within"). */
  sel: string;
  /** background-color / border-*-color / outline-color -> #rrggbb or rgba(). */
  decls: Record<string, string>;
}

export interface LearnedSet {
  /** The designs these were learned for (ids and versions); a different set discards them. */
  designKey: string;
  rules: LearnedRule[];
  updatedAt: number;
}

export const learnedKey = (host: string) => `learned:${host}`;
export const MAX_LEARNED = 300;

const SEL = /^[a-z][a-z0-9-]{0,40}(?:\.[A-Za-z_][\w-]{0,60}){1,2}(?::hover|:focus-within)?$/;
const PROPS = new Set(['background-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'outline-color']);
const VALUE = /^(?:#[0-9a-f]{6}|rgba\(\d{1,3}, \d{1,3}, \d{1,3}, (?:0|1|0?\.\d{1,4})\))$/;

export function validateLearned(raw: unknown): LearnedSet | null {
  const r = raw as Partial<LearnedSet> | null;
  if (!r || typeof r !== 'object' || typeof r.designKey !== 'string' || r.designKey.length > 2000) return null;
  const rules: LearnedRule[] = [];
  const seen = new Set<string>();
  for (const x of Array.isArray(r.rules) ? r.rules : []) {
    if (rules.length >= MAX_LEARNED) break;
    const sel = typeof x?.sel === 'string' ? x.sel : '';
    if (!SEL.test(sel) || seen.has(sel)) continue;
    const decls: Record<string, string> = {};
    for (const [p, v] of Object.entries(x?.decls && typeof x.decls === 'object' ? x.decls : {})) if (PROPS.has(p) && typeof v === 'string' && VALUE.test(v)) decls[p] = v;
    if (!Object.keys(decls).length) continue;
    seen.add(sel);
    rules.push({ sel, decls });
  }
  return { designKey: r.designKey, rules, updatedAt: Number.isFinite(r.updatedAt) ? Number(r.updatedAt) : Date.now() };
}

/** The stylesheet for learned rules: zero-specificity :where() + !important, like the other theme overrides. */
export function compileLearned(rules: LearnedRule[]): string {
  return rules
    .map((r) => {
      const m = /^(.*?)(:hover|:focus-within)?$/.exec(r.sel)!;
      return `:where(${m[1]})${m[2] ?? ''}{${Object.entries(r.decls).map(([k, v]) => `${k}:${v}!important`).join(';')}}`;
    })
    .join('\n');
}

/**
 * Which designs the theme layer is matching, by what they look like (their CSS and ops), not when they were last
 * saved: re-saving a design without changing its styles (a preview image, a folder, edits) keeps its learned
 * corrections and does not rebuild anything. (Keyed by save time, every re-save dropped them, so they flashed.)
 */
export function designKeyOf(designs: { id: string; css: string; ops?: unknown }[]): string {
  return designs
    .map((d) => {
      const text = d.css + JSON.stringify(d.ops ?? []);
      let h = 0x811c9dc5;
      for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
      return `${d.id}@${(h >>> 0).toString(36)}`;
    })
    .join('|');
}
