import type { Design, DomOp, Position } from '../shared/types';
import { sanitizeCss, sanitizeOps } from '../shared/validate';
import { withArt } from './art';

/**
 * Each DOM op becomes a runner with an idempotent ensure(): it re-checks the
 * page and fixes only what a re-render undid, so it's safe to call on every
 * mutation. A per-runner budget stops us fighting a page that keeps reverting us.
 */
interface Runner {
  ensure(): void;
  undo(): void;
  /** True only while this op's effect is really present in the page. */
  applied(): boolean;
}

interface Applied {
  id: string;
  /** 0 = site-wide, 1 = page-scoped. Page styles are kept after site styles so they win the cascade. */
  rank: number;
  updatedAt: number;
  styleEl: HTMLStyleElement;
  runners: Runner[];
}

const FIX_BUDGET = 150;
const MAX_MATCHES = 200;
// Compared against lowercase localName: SVG elements keep their case, so tagName.toUpperCase() checks miss <svg><style>.
const UNSAFE_TEXT_TARGETS = new Set(['style', 'script', 'noscript', 'textarea', 'input', 'select']);

const active = new Map<string, Applied>();

// Layers (site design, then page design) can edit the SAME text node or move the SAME element.
// The runner created last (highest seq) owns it; earlier layers stand down instead of fighting
// it, which would rewrite the node on every refresh and burn both repair budgets.
let seqCounter = 0;
const owners = new WeakMap<object, number>();

function q(selector: string): Element | null {
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

function qa(selector: string): Element[] {
  try {
    return Array.from(document.querySelectorAll(selector)).slice(0, MAX_MATCHES);
  } catch {
    return [];
  }
}

/** Is `el` where insertAdjacentElement(position, el) would have put it relative to `target`? */
function inPlace(el: Element, target: Element, position: Position): boolean {
  switch (position) {
    // "Before/after the target among its siblings", NOT "immediately adjacent": two moves aimed at the same
    // target would otherwise keep pushing each other out of adjacency forever.
    case 'beforebegin':
      return el.parentNode === target.parentNode && !!(el.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING);
    case 'afterend':
      return el.parentNode === target.parentNode && !!(el.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_PRECEDING);
    default:
      return el.parentNode === target; // afterbegin / beforeend: other children may come and go
  }
}

function makeRunner(op: Exclude<DomOp, { op: 'hide' }>, designId: string): Runner {
  let budget = FIX_BUDGET;
  const spend = () => budget-- > 0;
  const seq = ++seqCounter;

  switch (op.op) {
    case 'addClass': {
      const classes = op.className.split(/\s+/).filter(Boolean);
      // Remember exactly which classes WE added so undo never strips the page's own.
      const added = new Map<Element, string[]>();
      return {
        ensure() {
          for (const el of qa(op.selector)) {
            const missing = classes.filter((c) => !el.classList.contains(c));
            if (!missing.length || !spend()) continue;
            el.classList.add(...missing);
            added.set(el, [...(added.get(el) ?? []), ...missing]);
          }
        },
        undo() {
          for (const [el, cls] of added) el.classList.remove(...cls);
          added.clear();
        },
        applied() {
          return [...added.keys()].some((el) => el.isConnected && classes.some((c) => el.classList.contains(c)));
        },
      };
    }

    case 'setText': {
      // Edit a single text node, never textContent, so child elements/listeners survive.
      const originals = new Map<Text, string>();
      const findNode = (el: Element): Text | null => {
        // Never rewrite text that the browser executes or parses as code (CSS/JS), in any namespace.
        if (UNSAFE_TEXT_TARGETS.has(el.localName.toLowerCase()) || el.closest('style, script, noscript')) return null;
        for (const n of el.childNodes) {
          if (n.nodeType === Node.TEXT_NODE && (n as Text).data.trim()) return n as Text;
        }
        return null;
      };
      return {
        ensure() {
          for (const [node] of originals) if (!node.isConnected) originals.delete(node);
          let node = [...originals.keys()][0];
          if (!node) {
            const el = q(op.selector);
            node = (el && findNode(el)) as Text;
            if (!node) return;
            originals.set(node, node.data);
          }
          const owner = owners.get(node);
          if (owner !== undefined && owner > seq) return; // a later layer owns this text
          if (node.data !== op.text && spend()) {
            node.data = op.text;
            owners.set(node, seq);
          }
        },
        undo() {
          for (const [node, orig] of originals) node.data = orig;
          originals.clear();
        },
        applied() {
          return [...originals.keys()].some((n) => n.isConnected && n.data === op.text);
        },
      };
    }

    case 'move': {
      let el: Element | null = null;
      let moved = false;
      let origParent: Node | null = null;
      let origNext: Node | null = null;
      return {
        ensure() {
          if (!el || !el.isConnected) {
            el = q(op.selector);
            moved = false;
            if (el) {
              origParent = el.parentNode;
              origNext = el.nextSibling;
            }
          }
          const target = q(op.target);
          if (!el || !target || el === target || el.contains(target)) return;
          if (inPlace(el, target, op.position)) return; // already where it belongs (siblings included)
          const owner = owners.get(el);
          if (owner !== undefined && owner > seq) return; // a later layer owns this element
          if (!spend()) return;
          target.insertAdjacentElement(op.position, el);
          moved = true;
          owners.set(el, seq);
        },
        undo() {
          if (el && origParent?.isConnected) {
            const ref = origNext && origNext.parentNode === origParent ? origNext : null;
            origParent.insertBefore(el, ref);
          }
          el = null;
          moved = false;
        },
        applied() {
          const target = q(op.target);
          return moved && !!el && el.isConnected && !!target && inPlace(el, target, op.position);
        },
      };
    }

    case 'insert': {
      let el: HTMLElement | null = null;
      const build = (): HTMLElement => {
        const e = document.createElement(op.tag);
        e.setAttribute('data-ww', designId);
        if (op.text) e.textContent = op.text;
        if (op.className) e.className = op.className;
        if (op.style) e.setAttribute('style', withArt(op.style));
        if (op.src && e instanceof HTMLImageElement) e.src = withArt(op.src);
        return e;
      };
      return {
        ensure() {
          if (el?.isConnected) return;
          const target = q(op.target);
          if (!target || !spend()) return;
          el ??= build();
          target.insertAdjacentElement(op.position, el);
        },
        undo() {
          el?.remove();
          el = null;
        },
        applied() {
          return !!el?.isConnected;
        },
      };
    }
  }
}

/** All-sites designs are CSS-only: ops target one site's elements and make no sense everywhere. */
const designOps = (design: Design): DomOp[] => (design.scope === 'global' ? [] : sanitizeOps(design.ops));

function compileCss(design: Design): string {
  const hides = designOps(design)
    .filter((o): o is Extract<DomOp, { op: 'hide' }> => o.op === 'hide')
    .map((o) => `${o.selector}{display:none!important}`)
    .join('\n');
  // Sanitize the COMBINED text: the hide rules are built from validated selectors, but anything that ends up
  // inside the <style> must have been through the sanitizer, not just the model's own CSS.
  // Stored-picture tokens become real images only now, after sanitizing, so the size limit never cuts a picture off.
  return withArt(sanitizeCss(`${design.css}\n${hides}`));
}

function ensureStyleEl(applied: Applied): void {
  // The style lives on <html> (present at document_start). Re-attach if a page wipes it,
  // and keep it last so it wins the cascade over late-added site styles.
  const html = document.documentElement;
  if (applied.styleEl.parentNode === html) return;
  const later = Array.from(html.querySelectorAll(':scope > style[data-whimsyweb]')).find(
    (el) => Number(el.getAttribute('data-ww-rank')) > applied.rank,
  );
  html.insertBefore(applied.styleEl, later ?? null);
}

function runAll(applied: Applied): void {
  for (const r of applied.runners) {
    try {
      r.ensure();
    } catch {
      /* a broken op must never break the page or the other ops */
    }
  }
}

export function activate(design: Design, rank = 0): void {
  const existing = active.get(design.id);
  if (existing && existing.updatedAt === design.updatedAt) {
    ensureStyleEl(existing);
    runAll(existing);
    return;
  }
  if (existing) deactivate(design.id);

  const styleEl = document.createElement('style');
  styleEl.setAttribute('data-whimsyweb', design.id);
  styleEl.setAttribute('data-ww-rank', String(rank));
  styleEl.textContent = compileCss(design);
  const applied: Applied = {
    id: design.id,
    rank,
    updatedAt: design.updatedAt,
    styleEl,
    runners: designOps(design)
      .filter((o): o is Exclude<DomOp, { op: 'hide' }> => o.op !== 'hide')
      .map((o) => makeRunner(o, design.id)),
  };
  active.set(design.id, applied);
  ensureStyleEl(applied);
  runAll(applied);
}

export function deactivate(id: string): void {
  const applied = active.get(id);
  if (!applied) return;
  // Reverse order so stacked moves restore correctly.
  for (const r of [...applied.runners].reverse()) {
    try {
      r.undo();
    } catch {
      /* element may be gone */
    }
  }
  applied.styleEl.remove();
  active.delete(id);
}

/** Active design ids in the order they were applied (oldest first). */
export function activeIds(): string[] {
  return [...active.keys()];
}

/**
 * Whether our CSS or inserted HTML is genuinely in the document right now. Checks the live DOM,
 * not our own bookkeeping, so a design the page stripped out (or that never attached) reports false.
 */
export function appliedInDom(): boolean {
  const hasCss = Array.from(document.querySelectorAll('style[data-whimsyweb]')).some(
    (el) => el.isConnected && !!el.textContent?.trim(),
  );
  if (hasCss) return true;
  // Designs with no CSS can still change the page through text/class/move/insert ops.
  return [...active.values()].some((a) => a.runners.some((r) => r.applied()));
}

export function hasActive(): boolean {
  return active.size > 0;
}

/** Re-check every active design against the live DOM (called on page mutations). */
export function refresh(): void {
  for (const a of active.values()) {
    ensureStyleEl(a);
    runAll(a);
  }
}
