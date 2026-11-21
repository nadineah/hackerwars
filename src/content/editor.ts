import { EDIT_ATTR, upsertEdit, type VisualEdit } from '../shared/edits';
import type { FromPage, SelectionInfo, ToPage, TreeNode } from '../shared/editorProtocol';
import { currentEdits, setWorkingEdits } from './editLayer';
import { buildTarget, decorationsOf, isEditable, labelOf, leafText, openingTag, originOf, resolveTarget, similarOf, themeRulesFor } from './identity';

/**
 * Edit Mode on the page. Runs only while the side panel holds a `ww-editor` port to this tab; closing the port (Done,
 * the panel closing, another tab) ends it and puts the page back exactly as it was, keeping saved edits.
 *
 * While it runs, clicks on the page select instead of acting (links do not navigate, buttons do not press). Only the
 * selected element is outlined (never on hover): plum for the website's own elements, gold for ones a Whimsy Web
 * design created. The outline, handles and toolbar live in a shadow root, so neither the website's CSS nor a
 * theme can restyle or break them, and they never change the selected element's box.
 */

type Pseudo = '::before' | '::after';
interface Sel {
  el: Element;
  pseudo?: Pseudo;
}

const SITE_COLOR = '#7a5ea8';
const WW_COLOR = '#c9962e';

let port: chrome.runtime.Port | null = null;
let designId = '';
let edits: VisualEdit[] = [];
let sel: Sel | null = null;
let selTarget: ReturnType<typeof buildTarget> | null = null;
let expanded = new Set<string>();
let ui: Overlay | null = null;
let observer: MutationObserver | null = null;

const nodeIds = new WeakMap<Element, number>();
const byId = new Map<number, WeakRef<Element>>();
let nextNode = 1;
const idOf = (el: Element): string => {
  let n = nodeIds.get(el);
  if (!n) {
    n = nextNode++;
    nodeIds.set(el, n);
    byId.set(n, new WeakRef(el));
  }
  return String(n);
};
const fromId = (id: string): Sel | null => {
  const m = /^(\d+)(::before|::after)?$/.exec(id);
  if (!m) return null;
  const el = byId.get(Number(m[1]))?.deref();
  return el && el.isConnected ? { el, pseudo: m[2] as Pseudo | undefined } : null;
};

const post = (m: FromPage) => {
  try {
    port?.postMessage(m);
  } catch {
    /* the panel went away */
  }
};

export const editorActive = (): boolean => !!port;

// ------------------------------------------------------------------------------------------- start / stop

export function startEditor(p: chrome.runtime.Port): void {
  if (port) stopEditor();
  port = p;
  p.onMessage.addListener(onPanel);
  p.onDisconnect.addListener(() => {
    if (port === p) stopEditor();
  });
}

function begin(id: string, list: VisualEdit[]): void {
  designId = id;
  edits = list;
  void setWorkingEdits(designId, edits);
  if (!ui) {
    ui = new Overlay();
    for (const t of BLOCKED) window.addEventListener(t, guard, { capture: true, passive: false });
    window.addEventListener('keydown', onKey, true);
    document.documentElement.classList.add('ww-editing');
    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  post({ t: 'ready' });
}

export function stopEditor(): void {
  for (const t of BLOCKED) window.removeEventListener(t, guard, { capture: true } as EventListenerOptions);
  window.removeEventListener('keydown', onKey, true);
  document.documentElement.classList.remove('ww-editing');
  observer?.disconnect();
  observer = null;
  ui?.destroy();
  ui = null;
  sel = null;
  selTarget = null;
  expanded = new Set();
  const p = port;
  port = null;
  void setWorkingEdits(null);
  try {
    p?.disconnect();
  } catch {
    /* already closed */
  }
}

function onPanel(m: ToPage): void {
  switch (m.t) {
    case 'start':
      begin(m.designId, m.edits);
      return;
    case 'retarget':
      designId = m.designId;
      void setWorkingEdits(designId, edits);
      return;
    case 'stop':
      stopEditor();
      return;
    case 'select': {
      const s = fromId(m.id);
      if (s) select(s, true);
      return;
    }
    case 'clear':
      clearSelection();
      return;
    case 'children':
      post({ t: 'children', id: m.id, ...childrenOf(m.id) });
      return;
    case 'expanded':
      expanded = new Set(m.ids);
      return;
    case 'setEdits':
      edits = m.edits;
      void setWorkingEdits(designId, edits).then(sendInfo);
      return;
    case 'preview':
      void setWorkingEdits(designId, m.edits).then(() => ui?.place());
      return;
  }
}

// ------------------------------------------------------------------------------------------- clicks and keys

/** Everything that could make the page act on a click; while editing, the page never sees them. */
const BLOCKED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'submit', 'touchstart', 'touchend', 'dragstart'];

const isOurs = (e: Event) => !!ui && e.composedPath().includes(ui.host);

function guard(e: Event): void {
  if (isOurs(e)) return;
  if (e.type !== 'contextmenu') e.preventDefault(); // the browser's own menu stays available
  e.stopImmediatePropagation();
  if (e.type === 'click' && (e as MouseEvent).button === 0) {
    // the element itself, or the host of a component whose insides are private (a shadow root)
    const el = e.composedPath().find((n): n is Element => n instanceof Element && n.getRootNode() === document && isEditable(n));
    if (el) select({ el }, false);
  }
}

function onKey(e: KeyboardEvent): void {
  if (isOurs(e)) return;
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') {
    if (sel) {
      e.preventDefault();
      e.stopImmediatePropagation();
      clearSelection();
    }
    return;
  }
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.stopImmediatePropagation();
    post({ t: e.shiftKey ? 'redo' : 'undo' });
    return;
  }
  if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    e.stopImmediatePropagation();
    post({ t: 'redo' });
    return;
  }
  if (sel && /^Arrow(Up|Down|Left|Right)$/.test(e.key) && !mod) {
    const info = infoFor(sel);
    if (!info.caps.move) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const step = e.shiftKey ? 10 : 1;
    const [x, y] = currentTranslate(sel);
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    commitPatch({ translate: `${x + dx}px ${y + dy}px` }, 'Nudge');
  }
}

// ------------------------------------------------------------------------------------------- selection

function select(s: Sel, fromPanel: boolean): void {
  sel = s;
  selTarget = editOf(s)?.target ?? buildTarget(s.el, s.pseudo);
  if (fromPanel) {
    const r = s.el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) s.el.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
  ui?.show(s);
  post({ t: 'selected', info: infoFor(s), path: pathOf(s) });
}

function clearSelection(): void {
  sel = null;
  selTarget = null;
  ui?.hide();
  post({ t: 'cleared' });
}

function sendInfo(): void {
  if (!sel) return;
  if (!sel.el.isConnected) return void reattach();
  ui?.show(sel);
  post({ t: 'info', info: infoFor(sel) });
}

/** The selected element was replaced by the site (a re-render): find it again, or let go of it. */
function reattach(): void {
  if (!sel) return;
  const again = selTarget ? resolveTarget(selTarget) : [];
  if (again.length === 1) {
    sel = { el: again[0], pseudo: sel.pseudo };
    ui?.show(sel);
    post({ t: 'selected', info: infoFor(sel), path: pathOf(sel) });
  } else {
    sel = null;
    ui?.hide();
    post({ t: 'gone' });
  }
}

/** Ids from <body> down to the element (and its decoration), for the panel to open the tree to it. */
function pathOf(s: Sel): string[] {
  const chain: string[] = [];
  for (let n: Element | null = s.el; n && n !== document.documentElement; n = n.parentElement) chain.unshift(idOf(n));
  if (s.pseudo) chain.push(idOf(s.el) + s.pseudo);
  return chain;
}

/** The edit (of the design being edited) for this element, if any. */
function editOf(s: Sel): VisualEdit | undefined {
  const marks = (s.el.getAttribute(EDIT_ATTR) ?? '').split(' ').filter(Boolean);
  return edits.find((e) => marks.includes(e.id) && e.target.pseudo === s.pseudo);
}

const PROPS = [
  'width', 'height', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'color', 'background-color', 'background-image', 'opacity', 'border-top-width', 'border-top-style', 'border-top-color', 'border-top-left-radius', 'box-shadow',
  'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-decoration-line', 'text-transform',
  'display', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'gap', 'grid-template-columns', 'overflow', 'position', 'z-index',
  'object-fit', 'object-position', 'aspect-ratio', 'translate', 'scale', 'rotate', 'visibility', 'box-sizing',
];

function infoFor(s: Sel): SelectionInfo {
  const { el, pseudo } = s;
  const cs = getComputedStyle(el, pseudo);
  const base = pseudo ? { kind: 'decoration' as const, label: `Decoration · ${pseudo === '::before' ? 'before' : 'after'} ${labelOf(el).label}`.slice(0, 60), detail: '' } : labelOf(el);
  const computed: Record<string, string> = {};
  for (const p of PROPS) {
    const v = cs.getPropertyValue(p);
    computed[p] = p === 'background-image' && v.length > 200 ? v.slice(0, 200) + '…' : v;
  }
  const edit = editOf(s);
  const leaf = pseudo ? null : leafText(el);
  const r = el.getBoundingClientRect();
  const tag = el.tagName.toLowerCase();
  const page = tag === 'html' || tag === 'body';
  const parents: string[] = [];
  for (let p = el.parentElement, i = 0; p && p !== document.body && i < 3; p = p.parentElement, i++) {
    const pr = p.getBoundingClientRect();
    parents.push(`${labelOf(p).label} ${Math.round(pr.width)}x${Math.round(pr.height)}`);
  }
  const childCount = el.children.length;
  const html = pseudo
    ? `${openingTag(el)}\n  ${pseudo} (a decoration drawn by the design's CSS)\n</${tag}>`
    : `${openingTag(el)}${leaf ? leaf.data.trim().slice(0, 120) : childCount ? `\n  … ${childCount} element${childCount === 1 ? '' : 's'} inside …\n` : ''}</${tag}>`;
  return {
    id: idOf(el) + (pseudo ?? ''),
    kind: base.kind,
    label: base.label,
    tag,
    origin: pseudo ? 'webloom' : originOf(el),
    ...(pseudo ? { pseudo } : {}),
    target: edit?.target ?? buildTarget(el, pseudo),
    ...(edit ? { editId: edit.id, editCss: edit.css, editText: edit.text, editAll: edit.target.all } : { editCss: {} }),
    computed,
    box: { w: Math.round(r.width), h: Math.round(r.height) },
    html,
    themeRules: themeRulesFor(el, pseudo),
    text: leaf ? leaf.data : null,
    caps: {
      resize: !page && !pseudo && cs.display !== 'inline' && cs.display !== 'contents',
      move: !page,
      text: !!leaf,
      image: !pseudo && tag === 'img',
      hide: !page,
    },
    similar: pseudo ? null : similarOf(el),
    parents,
  };
}

// ------------------------------------------------------------------------------------------- changes from the page

/** Applies a change to the selected element locally (no history entry): used while dragging or sliding. */
function previewPatch(patch: Record<string, string | null>): void {
  if (!sel || !canKeep(sel, true)) return;
  const next = upsertEdit(edits, baseFor(sel), patch).edits;
  void setWorkingEdits(designId, next).then(() => ui?.place());
}

/** Applies a change to the selected element and hands it to the panel as one undo step. */
function commitPatch(patch: Record<string, string | null>, label: string): void {
  if (!sel) return;
  if (!canKeep(sel)) return;
  commit(upsertEdit(edits, baseFor(sel), patch).edits, label);
}

/** An element that cannot be found again after a reload cannot keep an edit: say so instead of losing it silently. */
function canKeep(s: Sel, quiet = false): boolean {
  const t = baseFor(s).target;
  if (t.selectors.length || t.all) return true;
  if (!quiet) post({ t: 'notice', text: 'This element cannot be found again reliably after a reload, so it cannot keep an edit. Try the element around it.' });
  return false;
}

function commit(next: VisualEdit[], label: string): void {
  edits = next;
  // send THIS change's list (a later change may replace `edits` before pictures finish loading)
  void setWorkingEdits(designId, next).then(() => {
    post({ t: 'commit', edits: next, label });
    sendInfo();
  });
}

function baseFor(s: Sel) {
  const e = editOf(s);
  return { editId: e?.id, target: e?.target ?? selTarget ?? buildTarget(s.el, s.pseudo), label: s.pseudo ? 'Decoration' : labelOf(s.el).label, origin: s.pseudo ? ('webloom' as const) : originOf(s.el) };
}

function currentTranslate(s: Sel): [number, number] {
  const v = getComputedStyle(s.el, s.pseudo).translate;
  if (!v || v === 'none') return [0, 0];
  const [x, y] = v.split(/\s+/).map((n) => parseFloat(n) || 0);
  return [x ?? 0, y ?? 0];
}

// ------------------------------------------------------------------------------------------- the tree

const MAX_CHILDREN = 150;

function nodeFor(el: Element): TreeNode {
  const { kind, label, detail } = labelOf(el);
  const cs = getComputedStyle(el);
  const kids = [...el.children].some(isEditable) || decorationsOf(el).length > 0;
  return {
    id: idOf(el),
    kind,
    label,
    detail,
    origin: originOf(el),
    hasChildren: kids,
    ...(cs.display === 'none' || cs.visibility === 'hidden' ? { hidden: true } : {}),
    ...(el.hasAttribute(EDIT_ATTR) ? { edited: true } : {}),
  };
}

function childrenOf(id: string): { nodes: TreeNode[]; more: number } {
  if (id === 'root') return { nodes: document.body ? [nodeFor(document.body)] : [], more: 0 };
  const s = fromId(id);
  if (!s || s.pseudo) return { nodes: [], more: 0 };
  const nodes: TreeNode[] = [];
  for (const p of decorationsOf(s.el)) {
    nodes.push({ id: idOf(s.el) + p, kind: 'decoration', label: `Decoration · ${p === '::before' ? 'before' : 'after'}`, detail: p, origin: 'webloom', hasChildren: false, ...(edits.some((e) => e.target.pseudo === p && (s.el.getAttribute(EDIT_ATTR) ?? '').includes(e.id)) ? { edited: true } : {}) });
  }
  const kids = [...s.el.children].filter(isEditable);
  for (const k of kids.slice(0, MAX_CHILDREN)) nodes.push(nodeFor(k));
  return { nodes, more: Math.max(0, kids.length - MAX_CHILDREN) };
}

let changed = new Set<string>();
let changeTimer: number | undefined;
function onMutations(records: MutationRecord[]): void {
  for (const r of records) {
    const t = r.target as Element;
    if (!(t instanceof Element) || t.tagName === 'WW-EDITOR' || (t as HTMLElement).id === 'ww-edits-style') continue;
    const n = nodeIds.get(t);
    if (n && expanded.has(String(n))) changed.add(String(n));
  }
  if (sel && !sel.el.isConnected) changed.add('__sel');
  if (!changed.size || changeTimer !== undefined) return;
  changeTimer = window.setTimeout(() => {
    changeTimer = undefined;
    const ids = [...changed].filter((x) => x !== '__sel');
    const selGone = changed.has('__sel');
    changed = new Set();
    if (ids.length) post({ t: 'treeChanged', ids });
    if (selGone) reattach();
  }, 400);
}

// ------------------------------------------------------------------------------------------- the overlay

const ICONS: Record<string, string> = {
  parent: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  move: '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
  hide: '<path d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.9 5.1A9.8 9.8 0 0112 5c5 0 9 5 9 7a11 11 0 01-2.4 3.3M6.6 6.6C4.5 8 3 10.2 3 12c0 2 4 7 9 7a9.6 9.6 0 004.2-1"/>',
  reset: '<path d="M3 12a9 9 0 109-9 9.7 9.7 0 00-6.7 2.8L3 8M3 3v5h5"/>',
  more: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  bold: '<path d="M7 5h6a3.5 3.5 0 010 7H7zM7 12h7a3.5 3.5 0 010 7H7z"/>',
  align: '<path d="M4 6h16M7 12h10M4 18h16"/>',
  smaller: '<path d="M4 18l4-10 4 10M5.5 14h5M15 12h6"/>',
  bigger: '<path d="M4 18l4-10 4 10M5.5 14h5M15 12h6M18 9v6"/>',
  fit: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 15l3-3 2 2 3-4 2 3"/>',
  corners: '<path d="M4 10V8a4 4 0 014-4h2M14 4h2a4 4 0 014 4v2M20 14v2a4 4 0 01-4 4h-2M10 20H8a4 4 0 01-4-4v-2"/>',
  opacity: '<path d="M12 3s6 6.5 6 11a6 6 0 01-12 0c0-4.5 6-11 6-11z"/>',
  front: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V6a2 2 0 012-2h10"/>',
  back: '<rect x="4" y="4" width="12" height="12" rx="2"/><path d="M20 8v10a2 2 0 01-2 2H8"/>',
  padMinus: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 12h6"/>',
  padPlus: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 12h6M12 9v6"/>',
};
const svg = (name: string) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ''}</svg>`;

const STYLE = `
:host { all: initial; }
.box { position: fixed; pointer-events: none; box-sizing: border-box; border: 2px solid var(--c); border-radius: 3px; box-shadow: 0 0 0 1px rgba(255,255,255,.85), 0 0 0 4px color-mix(in srgb, var(--c) 22%, transparent); display: none; }
.box.hidden-el { border-style: dashed; }
.chip { position: fixed; pointer-events: none; display: none; align-items: center; gap: 5px; max-width: 260px; padding: 3px 8px; border-radius: 999px; background: var(--c); color: #fff; font: 600 11.5px/1.3 'Figtree', system-ui, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 2px 6px rgba(40,30,60,.25); }
.h { position: fixed; width: 10px; height: 10px; margin: -5px 0 0 -5px; box-sizing: border-box; border: 2px solid var(--c); background: #fffdfb; border-radius: 3px; pointer-events: auto; display: none; touch-action: none; }
.h[data-h=n], .h[data-h=s] { cursor: ns-resize; } .h[data-h=e], .h[data-h=w] { cursor: ew-resize; }
.h[data-h=nw], .h[data-h=se] { cursor: nwse-resize; } .h[data-h=ne], .h[data-h=sw] { cursor: nesw-resize; }
.bar { position: fixed; display: none; align-items: center; gap: 2px; padding: 4px; border-radius: 12px; background: #fffaf6; border: 1px solid #e7ddd3; box-shadow: 0 6px 22px rgba(60,40,80,.18); pointer-events: auto; font: 500 13px/1 'Figtree', system-ui, sans-serif; color: #2b2631; }
.bar button { all: unset; display: inline-flex; align-items: center; justify-content: center; min-width: 30px; height: 30px; padding: 0 4px; box-sizing: border-box; border-radius: 8px; cursor: pointer; color: #2b2631; font: 700 12px/1 'Figtree', system-ui, sans-serif; }
.bar button:hover { background: #f0eaf8; color: #7a5ea8; }
.bar button:focus-visible { outline: 2px solid #cdbfe6; }
.bar button[disabled] { opacity: .35; cursor: default; background: none; }
.bar button.grip { cursor: grab; } .bar button.grip:active { cursor: grabbing; }
.bar .sep { width: 1px; height: 20px; background: #e7ddd3; margin: 0 3px; }
.bar input[type=color] { all: unset; width: 26px; height: 26px; border-radius: 7px; cursor: pointer; box-sizing: border-box; border: 1px solid #e7ddd3; margin: 0 2px; }
.bar input[type=color]::-webkit-color-swatch-wrapper { padding: 2px; } .bar input[type=color]::-webkit-color-swatch { border: none; border-radius: 5px; }
.pop { display: none; align-items: center; gap: 6px; padding: 0 6px; }
.pop.open { display: inline-flex; }
.pop input[type=range] { width: 90px; accent-color: #7a5ea8; }
.who { padding: 0 6px 0 4px; font-size: 11px; color: #6c6475; white-space: nowrap; }
`;

class Overlay {
  host: HTMLElement;
  private root: ShadowRoot;
  private box: HTMLElement;
  private chip: HTMLElement;
  private handles: HTMLElement[] = [];
  private bar: HTMLElement;
  private raf = 0;
  private drag: { kind: 'move' | 'resize'; h?: string; x: number; y: number; w: number; hgt: number; tx: number; ty: number; ratio: number; pad: [number, number] } | null = null;
  private dragPatch: Record<string, string> | null = null;
  private shown: Sel | null = null;

  constructor() {
    this.host = document.createElement('ww-editor');
    this.host.setAttribute('data-ww', 'editor');
    this.host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;display:block!important;';
    this.root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    this.box = document.createElement('div');
    this.box.className = 'box';
    this.chip = document.createElement('div');
    this.chip.className = 'chip';
    this.bar = document.createElement('div');
    this.bar.className = 'bar';
    this.bar.setAttribute('role', 'toolbar');
    this.root.append(style, this.box, this.chip, this.bar);
    for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const d = document.createElement('div');
      d.className = 'h';
      d.dataset.h = h;
      d.addEventListener('pointerdown', (e) => this.startDrag(e, 'resize', h));
      this.root.append(d);
      this.handles.push(d);
    }
    (document.body ?? document.documentElement).append(this.host);
    const style2 = document.createElement('style');
    style2.id = 'ww-editor-cursor';
    style2.textContent = 'html.ww-editing, html.ww-editing * { cursor: crosshair !important; }';
    document.documentElement.append(style2);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.host.remove();
    document.getElementById('ww-editor-cursor')?.remove();
  }

  show(s: Sel): void {
    const info = infoFor(s);
    const color = info.origin === 'webloom' ? WW_COLOR : SITE_COLOR;
    this.host.style.setProperty('--c', color);
    this.box.style.setProperty('--c', color);
    for (const el of [this.chip, ...this.handles]) el.style.setProperty('--c', color);
    this.chip.textContent = `${info.origin === 'webloom' ? '✦ ' : ''}${info.label}`;
    this.chip.title = info.origin === 'webloom' ? 'Created by Whimsy Web' : 'Part of the website';
    this.box.classList.toggle('hidden-el', info.computed.visibility === 'hidden' || info.computed.display === 'none' || info.box.w === 0);
    for (const h of this.handles) h.style.display = info.caps.resize ? 'block' : 'none';
    this.buildBar(s, info);
    this.shown = s;
    this.box.style.display = 'block';
    this.chip.style.display = 'inline-flex';
    this.bar.style.display = 'flex';
    cancelAnimationFrame(this.raf);
    const loop = () => {
      this.place();
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  hide(): void {
    cancelAnimationFrame(this.raf);
    this.shown = null;
    for (const el of [this.box, this.chip, this.bar, ...this.handles]) el.style.display = 'none';
  }

  /** Keeps everything on the element as it scrolls, resizes or moves, and the toolbar inside the window. */
  place(): void {
    const s = this.shown;
    if (!s || !s.el.isConnected) return;
    const r = s.el.getBoundingClientRect();
    Object.assign(this.box.style, { left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${Math.max(4, r.width + 4)}px`, height: `${Math.max(4, r.height + 4)}px` });
    const pos: Record<string, [number, number]> = { nw: [r.left, r.top], n: [r.left + r.width / 2, r.top], ne: [r.right, r.top], e: [r.right, r.top + r.height / 2], se: [r.right, r.bottom], s: [r.left + r.width / 2, r.bottom], sw: [r.left, r.bottom], w: [r.left, r.top + r.height / 2] };
    for (const h of this.handles) {
      const [x, y] = pos[h.dataset.h!];
      h.style.left = `${x}px`;
      h.style.top = `${y}px`;
    }
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const cw = this.chip.offsetWidth;
    const chipTop = r.top - 24 >= 4 ? r.top - 24 : Math.min(vh - 22, r.bottom + 4);
    this.chip.style.left = `${Math.min(Math.max(4, r.left), vw - cw - 4)}px`;
    this.chip.style.top = `${Math.max(4, chipTop)}px`;
    const bw = this.bar.offsetWidth;
    const bh = this.bar.offsetHeight;
    let top = r.bottom + 10;
    if (top + bh > vh - 6) top = r.top - bh - 30 >= 6 ? r.top - bh - 30 : Math.min(vh - bh - 6, Math.max(6, r.top + 6));
    this.bar.style.left = `${Math.min(Math.max(6, r.left), Math.max(6, vw - bw - 6))}px`;
    this.bar.style.top = `${Math.max(6, top)}px`;
  }

  private buildBar(s: Sel, info: SelectionInfo): void {
    this.bar.textContent = '';
    const add = (icon: string, title: string, onClick: () => void, opts: { disabled?: boolean; text?: string; grip?: boolean } = {}) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.innerHTML = opts.text ?? svg(icon);
      if (opts.disabled) b.disabled = true;
      if (opts.grip) {
        b.className = 'grip';
        b.addEventListener('pointerdown', (e) => this.startDrag(e, 'move'));
      } else b.addEventListener('click', onClick);
      this.bar.append(b);
      return b;
    };
    const sep = () => this.bar.append(Object.assign(document.createElement('span'), { className: 'sep' }));
    const color = (title: string, prop: string, current: string) => {
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.title = title;
      inp.setAttribute('aria-label', title);
      inp.value = toHex(current);
      inp.addEventListener('input', () => previewPatch({ [prop]: inp.value }));
      inp.addEventListener('change', () => commitPatch({ [prop]: inp.value }, title));
      this.bar.append(inp);
    };
    const slider = (icon: string, title: string, prop: string, value: number, min: number, max: number, toCss: (v: number) => string) => {
      const toggle = add(icon, title, () => pop.classList.toggle('open'));
      void toggle;
      const pop = document.createElement('span');
      pop.className = 'pop';
      const r = document.createElement('input');
      r.type = 'range';
      r.min = String(min);
      r.max = String(max);
      r.value = String(value);
      r.setAttribute('aria-label', title);
      r.addEventListener('input', () => previewPatch({ [prop]: toCss(Number(r.value)) }));
      r.addEventListener('change', () => commitPatch({ [prop]: toCss(Number(r.value)) }, title));
      pop.append(r);
      this.bar.append(pop);
    };
    const c = info.computed;
    const parent = s.el.parentElement;
    add('parent', 'Select the element around it', () => parent && isEditable(parent) && parent !== document.documentElement && select({ el: parent }, false), { disabled: !!s.pseudo || !parent || parent === document.documentElement });
    add('move', info.origin === 'webloom' ? 'Drag to move' : 'Drag to nudge (moves how it looks, not the page layout)', () => undefined, { grip: true, disabled: !info.caps.move });
    sep();
    const k = info.kind;
    if (k === 'text' || k === 'heading' || k === 'link' || k === 'button') {
      const fs = parseFloat(c['font-size']) || 16;
      add('smaller', 'Smaller text', () => commitPatch({ 'font-size': `${Math.max(8, Math.round(fs * 0.9))}px` }, 'Smaller text'));
      add('bigger', 'Bigger text', () => commitPatch({ 'font-size': `${Math.round(fs * 1.1)}px` }, 'Bigger text'));
      add('bold', 'Bold', () => commitPatch({ 'font-weight': Number(c['font-weight']) >= 600 ? '400' : '700' }, 'Bold'));
      const order = ['left', 'center', 'right'];
      add('align', `Align (now ${c['text-align']})`, () => commitPatch({ 'text-align': order[(order.indexOf(c['text-align'] === 'start' ? 'left' : c['text-align']) + 1) % 3] }, 'Alignment'));
      color('Text colour', 'color', c.color);
    } else if (k === 'image' || k === 'video') {
      const fits = ['cover', 'contain', 'fill'];
      if (info.caps.image) add('fit', `Fit (now ${c['object-fit']})`, () => commitPatch({ 'object-fit': fits[(fits.indexOf(c['object-fit']) + 1) % 3] }, 'Fit'));
      cornerButton(add, c);
      slider('opacity', 'Opacity', 'opacity', Math.round((parseFloat(c.opacity) || 1) * 100), 5, 100, (v) => String(v / 100));
    } else if (k === 'decoration') {
      slider('opacity', 'Opacity', 'opacity', Math.round((parseFloat(c.opacity) || 1) * 100), 5, 100, (v) => String(v / 100));
      const z = parseInt(c['z-index']) || 0;
      const needPos: Record<string, string> = c.position === 'static' ? { position: 'relative' } : {};
      add('front', 'Bring forward', () => commitPatch({ 'z-index': String(z + 1), ...needPos }, 'Bring forward'));
      add('back', 'Send backward', () => commitPatch({ 'z-index': String(z - 1), ...needPos }, 'Send backward'));
    } else {
      color('Background colour', 'background-color', c['background-color']);
      const pad = parseFloat(c['padding-top']) || 0;
      add('padMinus', 'Less padding', () => commitPatch({ padding: `${Math.max(0, pad - 8)}px` }, 'Less padding'), { disabled: k === 'page' });
      add('padPlus', 'More padding', () => commitPatch({ padding: `${pad + 8}px` }, 'More padding'), { disabled: k === 'page' });
      if (k !== 'page') cornerButton(add, c);
    }
    sep();
    const hiddenNow = info.editCss.visibility === 'hidden' || info.editCss.display === 'none';
    add('hide', hiddenNow ? 'Show it again' : 'Hide', () => {
      if (hiddenNow) commitPatch({ visibility: null, display: null }, 'Show');
      else commitPatch(info.origin === 'webloom' ? { display: 'none' } : { visibility: 'hidden' }, 'Hide');
    }, { disabled: !info.caps.hide });
    add('reset', 'Reset this element', () => {
      if (!sel) return;
      const e = editOf(sel);
      if (e) commit(edits.filter((x) => x.id !== e.id), 'Reset element');
    }, { disabled: !info.editId });
    add('more', 'More options in the side panel', () => post({ t: 'openOptions' }));
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = info.origin === 'webloom' ? 'Whimsy Web' : 'Website';
    this.bar.append(who);
  }

  private startDrag(e: PointerEvent, kind: 'move' | 'resize', h?: string): void {
    const s = this.shown;
    if (!s || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const r = s.el.getBoundingClientRect();
    const cs = getComputedStyle(s.el, s.pseudo);
    const [tx, ty] = currentTranslate(s);
    // content-box elements: width/height exclude padding and border
    const padX = cs.boxSizing === 'border-box' ? 0 : (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
    const padY = cs.boxSizing === 'border-box' ? 0 : (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    this.drag = { kind, h, x: e.clientX, y: e.clientY, w: r.width, hgt: r.height, tx, ty, ratio: r.width / Math.max(1, r.height), pad: [padX, padY] };
    this.dragPatch = null;
    const target = e.target as HTMLElement;
    const move = (ev: PointerEvent) => this.onDrag(ev);
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      const patch = this.dragPatch;
      const d = this.drag;
      this.drag = null;
      this.dragPatch = null;
      if (patch) commitPatch(patch, d?.kind === 'move' ? 'Move' : 'Resize');
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  private onDrag(e: PointerEvent): void {
    const d = this.drag;
    const s = this.shown;
    if (!d || !s) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (d.kind === 'move') {
      this.dragPatch = { translate: `${Math.round(d.tx + dx)}px ${Math.round(d.ty + dy)}px` };
    } else {
      const h = d.h ?? 'se';
      let w = d.w;
      let hh = d.hgt;
      let tx = d.tx;
      let ty = d.ty;
      if (h.includes('e')) w = d.w + dx;
      if (h.includes('w')) {
        w = d.w - dx;
        tx = d.tx + dx;
      }
      if (h.includes('s')) hh = d.hgt + dy;
      if (h.includes('n')) {
        hh = d.hgt - dy;
        ty = d.ty + dy;
      }
      // pictures keep their proportions when a corner is dragged
      if (h.length === 2 && infoKindIsImage(s)) hh = w / d.ratio;
      w = Math.max(8, w);
      hh = Math.max(8, hh);
      const patch: Record<string, string> = {};
      if (h.includes('e') || h.includes('w')) patch.width = `${Math.round(w - d.pad[0])}px`;
      if (h.includes('n') || h.includes('s') || (h.length === 2 && infoKindIsImage(s))) patch.height = `${Math.round(hh - d.pad[1])}px`;
      if (tx !== d.tx || ty !== d.ty) patch.translate = `${Math.round(tx)}px ${Math.round(ty)}px`;
      if (patch.width || patch.height) patch['max-width'] = 'none';
      this.dragPatch = patch;
    }
    previewPatch(this.dragPatch);
  }
}

const infoKindIsImage = (s: Sel) => !s.pseudo && /^(IMG|VIDEO|PICTURE|SVG|CANVAS)$/i.test(s.el.tagName);

function cornerButton(add: (icon: string, title: string, onClick: () => void) => HTMLButtonElement, c: Record<string, string>): void {
  const steps = ['0px', '12px', '24px', '50%'];
  const now = c['border-top-left-radius'];
  const i = steps.indexOf(now);
  add('corners', 'Rounder corners', () => commitPatch({ 'border-radius': steps[(i + 1) % steps.length] }, 'Corners'));
}

/** rgb()/rgba() -> #rrggbb for colour inputs (transparent shows as white). */
function toHex(css: string): string {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/.exec(css);
  if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return '#ffffff';
  return '#' + [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('');
}

/** For the edit layer to know which marks belong to Edit Mode's design (tests). */
export const editorState = () => ({ designId, edits, selected: sel ? idOf(sel.el) + (sel.pseudo ?? '') : null, current: currentEdits().length });
