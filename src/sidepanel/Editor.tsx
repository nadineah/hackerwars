import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TREE_BATCH } from '../shared/treeRange';
import { GOOGLE_FONTS, SLOTS, parseDeclarations, upsertEdit, validateEdits, type EditBase, type Slot, type VisualEdit, type InsertKind, type InsertPosition } from '../shared/edits';
import type { EditState, ElementView, FromPage, MoveMode, PartInfo, SelectionInfo, ToPage, TreeNode } from '../shared/editorProtocol';
import { ICON_GROUPS, ICON_SET, canFill, iconInMask, iconMatches, iconUrl } from '../shared/iconSet';
import { GRADIENT_DIRECTIONS, currentGradient, gradientCss, gradientPatch, parseGradient, partnerOf, type Gradient, type GradientUse } from '../shared/gradient';
import { GLOBAL_HOST, appliesOn, layerOf, scopeOf } from '../shared/scope';
import { getDesignsForHost } from '../shared/storage';
import type { AddElementResponse, AiChange, AiContextKind, Design, EditElementResponse, MutateMessage } from '../shared/types';
import { ChevronIcon, EyeIcon, EyeOffIcon, KindIcon, RedoIcon, SparkleIcon, UndoIcon } from './Icons';

/**
 * Edit Mode in the side panel: the element tree, Options and Code for the selected element, "ask Claude about this
 * element", and undo/redo/reset. The page (content/editor.ts) does the selecting, outlining and dragging; this view is
 * the single owner of the edits and their history: every change, from wherever it starts, becomes one step here, is
 * sent to the page and saved on the design (as its manual layer, above the AI's CSS).
 */

interface Entry {
  before: VisualEdit[];
  after: VisualEdit[];
  label: string;
  at: number;
}

interface Target {
  /** The design the edits are saved on; null until the first edit creates "My edits". */
  designId: string | null;
  /** Where that design is stored (its host, or "*" for an all-sites design). */
  bucket: string;
  name: string;
  create?: { scope: 'site' | 'page'; path: string };
  /** The edits' saved version this editor builds on (another tab saving first is detected, not overwritten). */
  version?: number;
}

const ask = async <T,>(m: unknown): Promise<T> => chrome.runtime.sendMessage(m) as Promise<T>;
async function mutate(host: string, m: Record<string, unknown>): Promise<{ designId?: string; token?: string; version?: number; conflict?: unknown; name?: string }> {
  const res = await ask<{ ok: boolean; error?: string; designId?: string; token?: string; version?: number; conflict?: unknown; name?: string }>({ type: 'ww:mutate', host, ...m } as MutateMessage);
  if (!res?.ok) throw new Error(res?.error ?? 'Could not save the change.');
  return res;
}

/** Which design the edits belong to: the page's or the site's own design here; otherwise a new "My edits" one. */
async function pickTarget(host: string, path: string, prefer?: string): Promise<{ target: Target; edits: VisualEdit[] }> {
  const [site, global] = await Promise.all([getDesignsForHost(host), getDesignsForHost(GLOBAL_HOST)]);
  // the File the panel is working on (the same design as the chat's)
  const chosen = prefer ? site.find((d) => d.id === prefer) : undefined;
  if (chosen) return { target: { designId: chosen.id, bucket: chosen.host, name: chosen.name, version: chosen.editsUpdatedAt ?? 0 }, edits: validateEdits(chosen.edits) };
  const here = [...site, ...global].filter((d) => d.enabled && appliesOn(d, host, path)).sort((a, b) => layerOf(b) - layerOf(a));
  const own = here.find((d) => scopeOf(d) !== 'global');
  if (own) return { target: { designId: own.id, bucket: own.host, name: own.name, version: own.editsUpdatedAt ?? 0 }, edits: validateEdits(own.edits) };
  return { target: { designId: null, bucket: host, name: 'My edits', create: { scope: 'site', path } }, edits: [] };
}

/** Which elements the tree lists and page clicks pick (remembered for this browser). */
const VIEW_KEY = 'ww-editor-view';
const readView = (): ElementView => {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === 'smart' || v === 'all') return v;
    if (v === 'visual') return 'smart'; // Drawn only is gone: Smart shows all it did, and the cards around them
    // from before Smart existed: someone who chose All elements keeps it
    return localStorage.getItem('ww-editor-visual') === 'all' ? 'all' : 'smart';
  } catch {
    return 'smart';
  }
};
const VIEWS: [ElementView, string, string][] = [
  ['smart', 'Smart', 'What you see, plus the cards, rows and sections it sits in. Wrappers and spacers are skipped.'],
  ['all', 'Everything', 'Every element, as the page is built (for spacing and layout).'],
];

const px = (v: string | undefined) => (v === undefined || v === '' ? '' : String(Math.round(parseFloat(v) * 10) / 10));
const SHADOWS: [string, string][] = [
  ['none', 'None'],
  ['0 1px 3px rgba(0,0,0,.18)', 'Subtle'],
  ['0 6px 18px rgba(0,0,0,.18)', 'Soft'],
  ['0 14px 40px rgba(0,0,0,.28)', 'Deep'],
  ['0 0 18px rgba(212,175,55,.65)', 'Golden glow'],
];

/** pinTo: the panel's pinned top bar; the editor's header and the selection's bar are shown there, so they never scroll away. */
/** Where the pinned top bar ends (the panel's content scrolls under it). */
const pinnedBottom = () => document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0;
/** Scrolls the panel so an element starts just below the pinned top bar (scrollIntoView would put it under the bar). */
function scrollBelowBar(el: HTMLElement, behavior: ScrollBehavior = 'auto'): void {
  window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - pinnedBottom() - 8, behavior });
}

/**
 * pinTo: the panel's pinned top bar; the editor's header and the selection's bar are shown there, so they never scroll away.
 * fileId: the design the panel's File is on (the chat's too): edits go there. onTarget: the design edits are saved on.
 */
export function Editor({ tabId, host, path, onExit, flash, pinTo, fileId, onTarget, allSitesFile }: { tabId: number; host: string; path: string; onExit: (why?: string) => void; flash: (t: string) => void; pinTo?: HTMLElement | null; fileId?: string; onTarget?: (designId: string | null) => void; allSitesFile?: string }) {
  const fileRef = useRef(fileId);
  fileRef.current = fileId;
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const [target, setTarget] = useState<Target | null>(null);
  const targetRef = useRef<Target | null>(null);
  const [edits, setEdits] = useState<VisualEdit[]>([]);
  const editsRef = useRef<VisualEdit[]>([]);
  const [past, setPast] = useState<Entry[]>([]);
  const [future, setFuture] = useState<Entry[]>([]);
  const [tree, setTree] = useState<Record<string, TreeLevelData>>({});
  /** The loaded part of each long list, so refreshes and page picks keep it (src/shared/treeRange.ts). */
  const rangesRef = useRef<Record<string, { start: number; end: number }>>({});
  /** The page's row was opened when the tree first loaded (once: opening it asks for the top level again). */
  const rootOpenedRef = useRef(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['root']));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [info, setInfo] = useState<SelectionInfo | null>(null);
  /** The selected element is hidden or gone for now (shown only on hover); the selection and its changes are kept. */
  const [hoverOnly, setHoverOnly] = useState(false);
  const [view, setView] = useState(readView);
  const viewRef = useRef(view);
  const [mode, setMode] = useState<'options' | 'code'>('options');
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  /** After a save conflict: this editor's own list (including changes made while that save was on its way), so
   * "Keep my version" can bring it back. Only for the design it came from; any other change drops it. */
  const [conflictMine, setConflictMine] = useState<{ designId: Target["designId"]; edits: VisualEdit[] } | null>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const closing = useRef(false);

  const send = useCallback((m: ToPage) => {
    try {
      portRef.current?.postMessage(m);
    } catch {
      /* the page went away */
    }
  }, []);

  // ---- saving: one chain, so a design is created at most once and saves land in order
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const saveTimer = useRef<number | undefined>(undefined);
  /** Opening another design (the File switched): changes wait until it is open. */
  const switchingRef = useRef(false);
  /** Counts design switches: only the latest one ends the pause on changes. */
  const switchTurn = useRef(0);
  /** Bumped to try a switch again (after a save that had failed goes through). */
  const [switchRetry, setSwitchRetry] = useState(0);
  /** Whether the last save went through (the Save button says so). */
  const lastSaveOk = useRef(true);
  /** Queues one save of the current edits. Every save (also the last one on exit) runs in this one chain, after the
   * previous one: a design is created at most once (later saves see its id) and an older list can never land last. */
  const queueSave = useCallback(() => {
    saveChain.current = saveChain.current.then(async () => {
      const t = targetRef.current;
      if (!t) return;
      setSaving('saving');
      try {
        const res = await mutate(t.bucket, { action: 'setEdits', ...(t.designId ? { id: t.designId, expectVersion: t.version } : { create: t.create }), edits: editsRef.current });
        if (res.conflict) {
          // edited in another tab meanwhile: show what is saved (never overwrite it silently); this editor's history
          // starts over, and its own latest list (also changes made after this save was sent) is kept for "Keep my version"
          const mine = editsRef.current;
          if (mine.length || t.designId) setConflictMine({ designId: t.designId, edits: mine });
          const saved = validateEdits(res.conflict);
          editsRef.current = saved;
          setEdits(saved);
          setPast([]);
          setFuture([]);
          targetRef.current = { ...t, version: res.version };
          setTarget(targetRef.current);
          send({ t: 'setEdits', edits: saved });
          setError('These edits were changed in another tab, so that version is shown now. Your changes here were not saved.');
          setSaving('error');
          lastSaveOk.current = false;
          return;
        }
        const next = { ...t, ...(res.designId ? { designId: res.designId } : {}), ...(t.designId ? {} : { name: res.name ?? t.name, create: undefined }), version: res.version ?? t.version };
        targetRef.current = next;
        setTarget(next);
        if (!t.designId && res.designId) send({ t: 'retarget', designId: res.designId });
        setSaving('saved');
        lastSaveOk.current = true;
      } catch (e) {
        setSaving('error');
        lastSaveOk.current = false;
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }, [send]);
  const save = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = undefined;
      queueSave();
    }, 300);
  }, [queueSave]);
  const flushSave = () => {
    if (saveTimer.current === undefined) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    queueSave();
  };

  /** One change from anywhere: history, the page, storage. */
  const apply = useCallback(
    (next: VisualEdit[], label: string, fromPage = false) => {
      if (switchingRef.current) {
        // the page is shown again as the design being opened, so a change from the page is not lost silently
        flash('One moment: opening the other design…');
        return;
      }
      const before = editsRef.current;
      editsRef.current = next;
      setEdits(next);
      setConflictMine(null);
      setFuture([]);
      setPast((p) => {
        const last = p[p.length - 1];
        // a run of nudges is one step
        if (last && last.label === label && label.startsWith('Nudge') && Date.now() - last.at < 1200) return [...p.slice(0, -1), { ...last, after: next, at: Date.now() }];
        return [...p.slice(-99), { before, after: next, label, at: Date.now() }];
      });
      if (!fromPage) send({ t: 'setEdits', edits: next });
      save();
    },
    [save, send],
  );
  const undo = useCallback(() => {
    setPast((p) => {
      const e = p[p.length - 1];
      if (!e) return p;
      editsRef.current = e.before;
      setEdits(e.before);
      setFuture((f) => [...f, e]);
      send({ t: 'setEdits', edits: e.before });
      save();
      return p.slice(0, -1);
    });
  }, [save, send]);
  const redo = useCallback(() => {
    setFuture((f) => {
      const e = f[f.length - 1];
      if (!e) return f;
      editsRef.current = e.after;
      setEdits(e.after);
      setPast((p) => [...p, e]);
      send({ t: 'setEdits', edits: e.after });
      save();
      return f.slice(0, -1);
    });
  }, [save, send]);

  // ---- tree
  const fetchChildren = useCallback(
    (id: string, want: { start?: number; end?: number; reveal?: string } = {}) => send({ t: 'children', id, ...rangesRef.current[id], ...want }),
    [send],
  );
  const loadMore = useCallback(
    (id: string, dir: 'earlier' | 'later') => {
      const r = rangesRef.current[id];
      if (!r) return;
      fetchChildren(id, dir === 'later' ? { start: r.start, end: r.end + TREE_BATCH } : { start: Math.max(0, r.start - TREE_BATCH), end: r.end });
    },
    [fetchChildren],
  );
  const expandPath = useCallback(
    (ids: string[]) => {
      setExpanded((cur) => {
        const next = new Set(cur);
        // each level is asked to include the next element on the path, even far down a long list
        ['root', ...ids.slice(0, -1)].forEach((id, i) => {
          if (!next.has(id)) next.add(id);
          fetchChildren(id, { reveal: ids[i] });
        });
        send({ t: 'expanded', ids: [...next] });
        return next;
      });
    },
    [fetchChildren, send],
  );
  const toggle = (id: string) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else {
        next.add(id);
        fetchChildren(id);
      }
      send({ t: 'expanded', ids: [...next] });
      return next;
    });
  };

  // ---- connect to the page
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const picked = await pickTarget(host, path, fileRef.current);
      if (cancelled) return;
      targetRef.current = picked.target;
      setTarget(picked.target);
      editsRef.current = picked.edits;
      setEdits(picked.edits);
      let port: chrome.runtime.Port;
      try {
        port = chrome.tabs.connect(tabId, { name: 'ww-editor' });
      } catch {
        onExit('Reload this tab so Whimsy Web can edit it.');
        return;
      }
      portRef.current = port;
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        portRef.current = null;
        if (!closing.current) onExit(readyRef.current ? 'Edit Mode ended because the page changed or reloaded.' : 'Reload this tab so Whimsy Web can edit it.');
      });
      port.onMessage.addListener((m: FromPage) => {
        switch (m.t) {
          case 'ready':
            readyRef.current = true;
            setReady(true);
            port.postMessage({ t: 'moveMode', mode: readMoveMode() } satisfies ToPage);
            rootOpenedRef.current = false; // a page (re)loaded: its rows are new, open the page's row again
            fetchChildren('root');
            return;
          case 'children':
            if (m.view !== viewRef.current) return; // an answer from before the view was switched
            rangesRef.current[m.id] = { start: m.start, end: m.end };
            setTree((t) => ({ ...t, [m.id]: { nodes: m.nodes, start: m.start, end: m.end, total: m.total } }));
            // the first time only: opening it asks for the top level again, and each answer opened it again (an endless
            // back and forth with the page, the panel redrawing all the time)
            if (m.id === 'root' && m.nodes[0] && !rootOpenedRef.current) {
              rootOpenedRef.current = true;
              expandPath([m.nodes[0].id, '_']);
            }
            return;
          case 'selected':
            revealRef.current = { id: m.info.id, until: Date.now() + 4000 };
            setInfo(m.info);
            setHoverOnly(false);
            setSelectedId(m.info.id);
            expandPath(m.path);
            return;
          case 'info':
            setInfo(m.info);
            return;
          case 'cleared':
            setHoverOnly(false);
            setInfo(null);
            setSelectedId(null);
            return;
          case 'aiContext':
            aiWaitRef.current?.({ text: m.text, refs: m.refs });
            aiWaitRef.current = null;
            return;
          case 'hoverOnly':
            setHoverOnly(m.on);
            return;
          case 'gone':
            setHoverOnly(false);
            setInfo(null);
            setSelectedId(null);
            flash('That element is no longer on the page');
            return;
          case 'treeChanged':
            for (const id of m.ids) fetchChildren(id);
            return;
          case 'commit':
            apply(m.edits, m.label, true);
            return;
          case 'undo':
            undo();
            return;
          case 'redo':
            redo();
            return;
          case 'notice':
            setError(m.text);
            return;
          case 'openOptions':
            setMode('options');
            if (optionsRef.current) scrollBelowBar(optionsRef.current, 'smooth');
            return;
        }
      });
      port.postMessage({ t: 'start', designId: picked.target.designId ?? 'new', edits: picked.edits, view: viewRef.current } satisfies ToPage);
    })();
    return () => {
      cancelled = true;
      closing.current = true;
      flushSave();
      try {
        portRef.current?.postMessage({ t: 'stop' } satisfies ToPage);
        portRef.current?.disconnect();
      } catch {
        /* gone */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  // The selected row is brought into view once it exists: the tree may still be loading the levels above it, so this
  // waits for them (each one re-renders) and gives up after a few seconds. Only the tree box scrolls, never the panel,
  // and a row that is already fully visible (e.g. just clicked in the tree) does not move.
  const revealRef = useRef<{ id: string; until: number } | null>(null);
  useEffect(() => {
    const want = revealRef.current;
    const box = treeRef.current;
    if (!want || !box) return;
    if (Date.now() > want.until || want.id !== selectedId) {
      revealRef.current = null;
      return;
    }
    const row = box.querySelector<HTMLElement>(`[data-node="${CSS.escape(want.id)}"]`);
    if (!row) return;
    revealRef.current = null;
    const b = box.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    if (r.top < b.top + 4 || r.bottom > b.bottom - 4) box.scrollTop += r.top - b.top - (box.clientHeight - r.height) / 2;
    // deep rows are indented: keep the start of the row (arrow, icon, name) in view
    const start = (row.querySelector(".ed-twisty, .ed-twisty-space") ?? row).getBoundingClientRect().left;
    if (start < b.left + 4 || start > b.left + box.clientWidth * 0.6) box.scrollLeft += start - b.left - 16;
    // the tree box itself may be scrolled out of the panel
    const pb = box.getBoundingClientRect();
    if (pb.bottom < pinnedBottom() || pb.top > window.innerHeight) scrollBelowBar(box);
  }, [selectedId, tree, expanded]);

  // Ctrl+Z / Ctrl+Shift+Z in the panel too (not while typing in a field)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.key === 'Escape' && info) send({ t: 'clear' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, info, send]);

  // ---- changes to the selected element
  const alsoSelected = useMemo(() => new Set(info?.multi?.ids ?? []), [info]);
  const base = useMemo(() => (info ? { editId: info.editId, target: info.target, label: info.label, origin: info.origin } : null), [info]);
  /** What a change is written to: every selected element (or the one group edit of Select similar), else the one. */
  const targets = useMemo(() => (info?.multi ? info.multi.bases : base ? [base] : []), [info, base]);
  const applyAll = (patch: Record<string, string | null>, opts: ChangeOpts = {}) => {
    let next = editsRef.current;
    for (const b of targets) next = upsertEdit(next, b, patch, info?.multi ? { slot: opts.slot } : opts).edits;
    return next;
  };
  const change: Change = (patch, label, opts = {}) => {
    if (!targets.length) return;
    apply(applyAll(patch, opts), info?.multi ? `${label} (${info.multi.count})` : label);
  };
  const preview: Preview = (patch, slot) => {
    if (!targets.length) return;
    send({ t: 'preview', edits: applyAll(patch, { slot }) });
  };
  /** A change to a part (the icon, the hover overlay): its own edit, possibly in several style sets at once. */
  const partEdits = (part: PartInfo, sets: PartPatch[]) => {
    let next = editsRef.current;
    let b: EditBase = part.base;
    for (const s of sets) {
      const r = upsertEdit(next, b, s.patch, { slot: s.slot });
      next = r.edits;
      b = { ...b, editId: r.editId };
    }
    return next;
  };
  const changePart: ChangePart = (part, sets, label) => apply(partEdits(part, sets), label);

  /** Modify with Claude: more of the page around the selection (from the page), and what each ref in it changes. */
  const aiWaitRef = useRef<((c: AiContext) => void) | null>(null);
  const askContext = (want: AiContextKind[]): Promise<AiContext> =>
    new Promise((resolve) => {
      aiWaitRef.current?.({ text: '', refs: {} }); // an earlier question nobody answered
      aiWaitRef.current = resolve;
      send({ t: 'aiContext', want });
      window.setTimeout(() => {
        if (aiWaitRef.current === resolve) {
          aiWaitRef.current = null;
          resolve({ text: '', refs: {} });
        }
      }, 4000);
    });
  /** Claude's changes, to the selection and to the other elements it chose: one step to undo. */
  const applyAi = (changes: AiChange[], refs: Record<string, EditBase>, label: string) => {
    let next = editsRef.current;
    const bases: Record<string, EditBase> = { ...refs };
    let selBases = targets.map((b) => ({ ...b }));
    for (const c of changes) {
      const slot = c.state === 'normal' ? undefined : (c.state as Slot);
      if (c.target === 'selection') {
        let patch: Record<string, string | null> = c.css;
        // its normal look comes as the complete set: what it leaves out of its manual declarations goes (not for a
        // style: Claude is asked only for what to change there)
        if (!slot && !info?.multi && info) {
          patch = {};
          for (const k of Object.keys(info.editCss)) if (!(k in c.css)) patch[k] = null;
          Object.assign(patch, c.css);
        }
        selBases = selBases.map((b) => {
          const r = upsertEdit(next, b, patch, slot ? { slot } : {});
          next = r.edits;
          return { ...b, editId: r.editId };
        });
      } else {
        const b = bases[c.target];
        if (!b) continue;
        const r = upsertEdit(next, b, c.css, slot ? { slot } : {});
        next = r.edits;
        bases[c.target] = { ...b, editId: r.editId };
      }
    }
    if (next !== editsRef.current) apply(next, label);
  };
  const previewPart: PreviewPart = (part, sets) => send({ t: 'preview', edits: partEdits(part, sets) });
  const val = (prop: string) => info?.editCss[prop] ?? info?.computed[prop] ?? '';
  /** Which option cards are open (remembered for this browser): Appearance by default, the others closed. */
  const [cards, setCards] = useState<Record<string, boolean>>(readCards);
  const toggleCard = (id: string) =>
    setCards((c) => {
      const next = { ...c, [id]: !(c[id] ?? OPEN_FIRST.has(id)) };
      try {
        localStorage.setItem(CARDS_KEY, JSON.stringify(next));
      } catch {
        /* not remembered */
      }
      return next;
    });
  const cardOpen = (id: string) => cards[id] ?? OPEN_FIRST.has(id);
  /** The page's row (the tree's first): Page background selects it and opens Appearance on its Normal look. */
  const pageRowId = tree.root?.nodes.find((n) => n.kind === 'page')?.id ?? null;
  const pagePicked = () => {
    if (!pageRowId) return;
    send({ t: 'select', id: pageRowId });
    if (!cardOpen('appearance')) toggleCard('appearance');
    window.setTimeout(() => {
      pickLookRef.current('normal');
      if (optionsRef.current) scrollBelowBar(optionsRef.current, 'smooth');
    }, 250);
  };
  /**
   * The path shown in the pinned bar: what the selection sits in, the selection, and (after going up with Select
   * parent or a second click) the elements it came from, so one click goes back down.
   */
  const [trail, setTrail] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    if (!info || info.multi) return;
    const path = [...(info.crumbs ?? []), { id: info.id, label: info.label }];
    setTrail((old) => {
      const i = old.findIndex((c) => c.id === info.id);
      return i >= 0 ? [...path, ...old.slice(i + 1)] : path;
    });
  }, [info?.id, info?.label, info?.crumbs, info?.multi]);
  /** Select child: back down to where Select parent came from, else the first thing inside it (its list is fetched). */
  const below = info && !info.multi ? trail[trail.findIndex((c) => c.id === info.id) + 1] : undefined;
  const firstInside = info ? tree[info.id]?.nodes.find((n) => n.kind !== 'decoration') : undefined;
  const child = below ?? (firstInside ? { id: firstInside.id, label: firstInside.label } : undefined);
  useEffect(() => {
    if (info && !info.multi && !info.pseudo && !below && !tree[info.id]) fetchChildren(info.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.id, below]);
  /** Normal, or the hover / focus look being edited (shown on the page while its tab is open). */
  const [look, setLook] = useState<EditState>('normal');
  /**
   * The Hover and Focus boxes by the selection's name: while ticked, the page shows that look (the site's own effects,
   * faked, and the ones made here) for as long as it is selected. They go with the Appearance tabs: picking a tab
   * ticks its box, ticking a box opens its tab. A new selection starts on Normal with both off; one that only shows on
   * hover opens on Hover with Hover ticked (so it stays on the page).
   */
  const [shown, setShown] = useState({ hover: false, focus: false });
  /** The Hover overlay group shows the hover look while the pointer is over it. */
  const [peek, setPeek] = useState(false);
  // the same selection keeps its look when the page rebuilds the element (a hover card made again)
  const selKey = info ? `${info.target.selectors.join('|')}${info.pseudo ?? ''}` || info.id : null;
  useEffect(() => {
    const h = !!info?.showsOnHover;
    setLook(h ? 'hover' : 'normal');
    setShown({ hover: h, focus: false });
    setPeek(false);
  }, [selKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // it turned out to show only while pointed at (it just went away, or the page says so): Hover on, its tab open
  useEffect(() => {
    if (!info?.showsOnHover && !hoverOnly) return;
    setShown({ hover: true, focus: false });
    if (info?.states.includes('hover')) setLook((l) => (l === 'normal' ? 'hover' : l));
  }, [info?.showsOnHover, hoverOnly]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (info) send({ t: 'looks', hover: shown.hover || peek, focus: shown.focus });
    // again when more are selected with it (all like this, ctrl-click): they show the look too
  }, [shown.hover, shown.focus, peek, info?.id, info?.multi?.count]); // eslint-disable-line react-hooks/exhaustive-deps
  const showLook = (s: EditState) => setPeek(s === 'hover');
  const pickLookRef = useRef<(s: EditState) => void>(() => {});
  const pickLook = (s: EditState) => {
    setLook(s);
    setPeek(false);
    // the tabs and the Show boxes go together: the page shows the look being edited. Normal shows neither, except for
    // something that only exists while pointed at (a tooltip): it stays shown, or it would vanish
    if (s === 'hover' || s === 'focus') setShown({ hover: s === 'hover', focus: s === 'focus' });
    else setShown({ hover: !!info?.showsOnHover || hoverOnly, focus: false });
  };
  pickLookRef.current = pickLook;
  const tickLook = (s: 'hover' | 'focus', on: boolean) => {
    // ticking one unticks the other
    setShown(on ? { hover: s === 'hover', focus: s === 'focus' } : (v) => ({ ...v, [s]: false }));
    setPeek(false);
    if (on) setLook(s);
    else if (look === s) setLook('normal');
  };

  const resetElement = () => {
    const ids = new Set(targets.map((b) => b.editId).filter(Boolean));
    if (!info?.multi) for (const p of [info?.parts.icon, info?.parts.overlay]) if (p?.base.editId) ids.add(p.base.editId);
    if (ids.size) apply(editsRef.current.filter((e) => !ids.has(e.id)), info?.multi ? 'Reset selection' : 'Reset element');
  };
  const resetAll = () => {
    if (!editsRef.current.length) return;
    if (!window.confirm(`Remove all ${editsRef.current.length} manual edit${editsRef.current.length === 1 ? '' : 's'} on this design? The design itself stays. You can undo this.`)) return;
    apply([], 'Reset all edits');
  };

  /** Switch which elements the tree lists: it is built again, open to the selection. */
  const switchView = (next: ElementView) => {
    if (next === viewRef.current) return;
    viewRef.current = next;
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* not remembered */
    }
    rangesRef.current = {};
    rootOpenedRef.current = false;
    setTree({});
    const start = new Set(['root']);
    setExpanded(start);
    send({ t: 'mode', view: next });
    send({ t: 'expanded', ids: [...start] });
    fetchChildren('root');
  };

  // the File switched to another design while editing (New design, or another opened): save what is pending to the
  // old one, then carry on with the new one (its own edits and history)
  useEffect(() => {
    if (!fileId || !ready || fileId === targetRef.current?.designId) {
      switchingRef.current = false; // nothing to open (or back on the design already open)
      return;
    }
    let stop = false;
    // only the latest switch may say it is done: an earlier one cancelled on the way must not let changes through
    const turn = ++switchTurn.current;
    switchingRef.current = true;
    void (async () => {
      try {
        if (saveTimer.current !== undefined) {
          window.clearTimeout(saveTimer.current);
          saveTimer.current = undefined;
          queueSave();
        }
        await saveChain.current;
        if (stop) return;
        if (!lastSaveOk.current) {
          // never drop changes that did not save: stay on the design they belong to
          setError(`Your last changes to “${targetRef.current?.name ?? 'this design'}” could not be saved, so Edit Mode stays on it. Try Save again before opening another design.`);
          return;
        }
        const picked = await pickTarget(host, path, fileId);
        if (stop || picked.target.designId !== fileId) return;
        targetRef.current = picked.target;
        setTarget(picked.target);
        editsRef.current = picked.edits;
        setEdits(picked.edits);
        setConflictMine(null);
        setPast([]);
        setFuture([]);
        send({ t: 'retarget', designId: fileId });
        send({ t: 'setEdits', edits: picked.edits });
      } finally {
        if (switchTurn.current === turn) switchingRef.current = false;
      }
    })();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, ready, switchRetry]);
  useEffect(() => {
    onTarget?.(target?.designId ?? null);
  }, [target?.designId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Save: saves now (edits are also saved by themselves as they are made) and stays in Edit Mode. */
  const saveNow = () => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    if (!targetRef.current?.designId && !editsRef.current.length) return flash('Nothing to save yet');
    queueSave();
    void saveChain.current.then(() => {
      if (!lastSaveOk.current) return;
      flash('Saved');
      // a design switch held back by a failed save goes ahead now
      if (fileRef.current && fileRef.current !== targetRef.current?.designId) {
        setError('');
        setSwitchRetry((n) => n + 1);
      }
    });
  };

  const partEdited = !info?.multi && [info?.parts.icon, info?.parts.overlay].some((p) => !!p?.base.editId);
  const canReset = !!info && (info.multi ? targets.some((b) => !!b.editId) : !!info.editId || partEdited);
  const pinned = (
    <div className="ed-pinned">
      <div className="ed-head">
        <div className="ed-title">
          <strong>Editing {host.replace(/^www\./, '')}</strong>
          <span className="hint" title="Your edits are a design for this site. Find it under This site or in the Library, where you can turn it off, rename or delete it.">
            {saving === 'saving' ? 'Saving…' : saving === 'error' ? 'Not saved' : edits.length ? `${edits.length} edit${edits.length === 1 ? '' : 's'}${saving === 'saved' ? ' · saved' : ''}` : 'No edits yet'}
          </span>
        </div>
        <div className="ed-actions">
          <button className="icon-btn" onClick={undo} disabled={!past.length} aria-label={past.length ? `Undo ${past[past.length - 1].label}` : 'Undo'} title={past.length ? `Undo: ${past[past.length - 1].label}` : 'Undo'}>
            <UndoIcon size={19} />
          </button>
          <button className="icon-btn" onClick={redo} disabled={!future.length} aria-label="Redo" title={future.length ? `Redo: ${future[future.length - 1].label}` : 'Redo'}>
            <RedoIcon size={19} />
          </button>
          <button className="ghost small-btn" onClick={resetAll} disabled={!edits.length} title="Remove every manual edit (the design itself stays)">
            Reset all
          </button>
          <button className="primary small-btn" onClick={saveNow} disabled={saving === 'saving'} title="Save now. Changes are also saved by themselves as you make them.">
            {saving === 'saving' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      {error && (
        <p className="ed-error" role="alert">
          {error}
          {conflictMine && conflictMine.designId === target?.designId && (
            <>
              {' '}
              <button
                type="button"
                className="ed-error-action"
                onClick={() => {
                  const mine = conflictMine.edits;
                  setError('');
                  // one undoable step on top of the other tab's version; saving it replaces that version
                  apply(mine, 'Keep my version');
                }}
              >
                Keep my version
              </button>
            </>
          )}
        </p>
      )}
      {allSitesFile && (
        <p className="hint ed-allsites">
          “{allSitesFile}” is for all sites, and hand edits fit one site only, so they are saved in “{target?.name ?? 'My edits'}” for this site, on top of it.
        </p>
      )}
      {info && (
        <div className="ed-selbar" role="group" aria-label="Selected element">
          <div className="ed-sel">
            <span className={info.origin === 'webloom' ? 'ed-badge ww' : 'ed-badge site'} title={info.origin === 'webloom' ? 'Created by Whimsy Web' : 'Part of the website (restyled or not)'}>
              {info.origin === 'webloom' ? <SparkleIcon size={13} /> : <KindIcon kind={info.kind} size={13} />}
              {info.origin === 'webloom' ? 'Whimsy Web' : 'Website'}
            </span>
            <strong className="ed-sel-name">{info.label}</strong>
            {info.multi && <span className="ed-sel-count">{info.multi.group ? `all ${info.multi.count}` : `+ ${info.multi.count - 1} more`}</span>}
            {!info.multi && (
              <span className="hint">
                {info.box.w}×{info.box.h}
              </span>
            )}
          </div>
          <div className="ed-selbar-actions">
            {info.multi?.group || (info.similar && !info.multi) ? (
              <button
                className={info.multi?.group ? 'ed-all on' : 'ed-all'}
                role="switch"
                aria-checked={!!info.multi?.group}
                onClick={() => send({ t: info.multi?.group ? 'selectOnly' : 'selectSimilar' })}
                title={info.multi?.group ? 'On: every change below goes to all of them, also ones that load later. Turn off to change this one only.' : 'Off: changes go to this one only. Turn on to select every element like it and change them all together.'}
              >
                <span className="ed-switch" aria-hidden="true" />
                All {info.multi?.group ? info.multi.count : info.similar!.count} like this
              </button>
            ) : info.multi ? (
              <button className="ghost small-btn" onClick={() => send({ t: 'selectOnly' })} title="Changes apply to each selected element. Ctrl/Shift-click adds or takes one out.">
                Only this one
              </button>
            ) : null}
            {!info.added && (
              <button className="ghost small-btn" onClick={resetElement} disabled={!canReset} title={canReset ? 'Take away the changes made to it' : 'Nothing changed on it yet'}>
                {info.multi ? 'Reset these' : 'Reset element'}
              </button>
            )}
            {/* also for several selected (all like this): each shows the look */}
            {(info.states.length > 0 || info.showsOnHover || hoverOnly) && (
              <span className="ed-look-checks" role="group" aria-label="Show on the page">
                <span className="ed-look-checks-label">Show</span>
                {(info.states.includes('hover') || info.showsOnHover || hoverOnly) && (
                  <label className="ed-hover-check" title={info.showsOnHover ? 'It only shows while pointed at: ticked, it stays on the page while you edit it' : 'Show it on the page as if pointed at: the site’s own hover effects and yours'}>
                    <input type="checkbox" checked={shown.hover} onChange={(e) => tickLook('hover', e.target.checked)} />
                    <span>Hover</span>
                  </label>
                )}
                {info.states.includes('focus') && (
                  <label className="ed-hover-check" title="Show it on the page as if focused (clicked into, or reached with Tab): the site’s own focus effects and yours">
                    <input type="checkbox" checked={shown.focus} onChange={(e) => tickLook('focus', e.target.checked)} />
                    <span>Focus</span>
                  </label>
                )}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="editor">
      {pinTo ? createPortal(pinned, pinTo) : pinned}
      <Card id="select" title="Select" hint={ready ? undefined : 'Connecting…'} open={cardOpen('select')} onToggle={toggleCard}>
        <div className="ed-tip-row">
          <p className="hint ed-tip">{ready ? 'Select the same spot to target the element’s parent.' : 'Connecting to the page…'}</p>
          {ready && pageRowId && (
            <button className="ghost small-btn" onClick={pagePicked} title="Select the page itself, to change the background behind everything">
              Page background
            </button>
          )}
        </div>
            {info && !info.multi && (
              <div className="ed-path">
                <button className="ghost small-btn" disabled={!info.crumbs?.length} onClick={() => info.crumbs?.length && send({ t: 'select', id: info.crumbs[info.crumbs.length - 1].id })} title={info.crumbs?.length ? `Select ${info.crumbs[info.crumbs.length - 1].label} (or click the same spot on the page again)` : 'Nothing above it to select'}>
                  ↑ Select parent
                </button>
                <button className="ghost small-btn" disabled={!child} onClick={() => child && send({ t: 'select', id: child.id })} title={child ? `Select ${child.label}` : 'Nothing inside it to select'}>
                  ↓ Select child
                </button>
                <nav className="ed-crumbs" aria-label="Where it is">
                  {trail.map((c, i) => {
                    const here = trail.findIndex((x) => x.id === info.id);
                    return (
                      <span key={c.id} className="ed-crumb">
                        {i > 0 && (
                          <span className="ed-crumb-sep" aria-hidden="true">
                            ›
                          </span>
                        )}
                        {c.id === info.id ? (
                          <span className="ed-crumb-here" aria-current="true">
                            {c.label}
                          </span>
                        ) : (
                          <button className={i > here ? 'ed-crumb-btn below' : 'ed-crumb-btn'} onClick={() => send({ t: 'select', id: c.id })} title={i > here ? `Back to ${c.label}` : `Select ${c.label}`}>
                            {c.label}
                          </button>
                        )}
                      </span>
                    );
                  })}
                </nav>
              </div>
            )}
        <div className="ed-view">
          <div className="seg-row ed-seg" role="radiogroup" aria-label="Which elements to show">
            {VIEWS.map(([v, name, title]) => (
              <button key={v} role="radio" aria-checked={view === v} className={view === v ? 'seg active' : 'seg'} onClick={() => switchView(v)} title={title}>
                {name}
              </button>
            ))}
          </div>
        </div>
        <div className="ed-tree" ref={treeRef} role="tree" aria-label="Page elements">
          <TreeLevel id="root" depth={0} tree={tree} expanded={expanded} selectedId={selectedId} alsoSelected={alsoSelected} onToggle={toggle} onMore={loadMore} onSelect={(id, add) => send({ t: 'select', id, add })} onHide={(id) => send({ t: 'toggleHidden', id })} />
        </div>
      </Card>

      {info ? (
        <div className="ed-panel" ref={optionsRef}>
          {info.multi && <p className="hint ed-multi-note">{info.multi.group ? `Changes below go to all ${info.multi.count} like this, also ones that load later.` : `Changes below go to each of the ${info.multi.count} selected.`}</p>}
          <Card id="appearance" title="Appearance" hint={look !== 'normal' ? (look === 'hover' ? 'Hover look' : 'Focus look') : undefined} open={cardOpen('appearance')} onToggle={toggleCard}>
            {info.states.length > 0 && (
              <div className="ed-looks">
                <div className="seg-row ed-seg" role="radiogroup" aria-label="Which look to edit">
                  {(['normal', ...info.states] as EditState[]).map((st) => (
                    <button key={st} role="radio" aria-checked={look === st} className={look === st ? 'seg active' : 'seg'} onClick={() => pickLook(st)}>
                      {st === 'normal' ? 'Normal' : st === 'hover' ? 'Hover' : 'Focus'}
                      {st !== 'normal' && (Object.keys(info.editSlots[st] ?? {}).length > 0 || (st === 'hover' && [info.parts.icon, info.parts.overlay].some((p) => Object.keys(p?.editSlots.hover ?? {}).length))) && <span className="ed-dot" aria-label="(changed)" />}
                    </button>
                  ))}
                </div>
                {look !== 'normal' && <p className="hint">{look === 'hover' ? 'Shown on the page now. These changes apply while the pointer is over it (or over the button or link it is part of).' : 'Shown on the page now. These changes apply while it is focused: clicked into, or reached with the Tab key.'}</p>}
              </div>
            )}
            {look === 'normal' ? (
              <OptionsPane info={info} val={val} change={change} preview={preview} changePart={changePart} previewPart={previewPart} host={host} setError={setError} send={send} showLook={showLook} look={look} onHoverTab={() => pickLook('hover')} />
            ) : (
              <StatePane info={info} state={look} val={val} change={change} preview={preview} changePart={changePart} previewPart={previewPart} showLook={showLook} send={send} host={host} setError={setError} />
            )}
          </Card>
          {(info.caps.move || info.caps.hide) && (
            <Card id="position" title="Position" hint={!info.multi && info.repeated ? `One of ${info.repeated} alike` : info.move.moved ? 'Moved' : undefined} open={cardOpen('position')} onToggle={toggleCard}>
              <PositionPane info={info} val={val} change={change} send={send} />
            </Card>
          )}
          {info.caps.add && (
            <Card id="add" title="Add an element" open={cardOpen('add')} onToggle={toggleCard}>
              <AddElement host={host} info={info} send={send} setError={setError} />
            </Card>
          )}
          <Card id="ask" title="Modify with Claude" hint={info.multi ? `${info.multi.count} selected` : "this element"} open={cardOpen('ask')} onToggle={toggleCard}>
            <AskClaude info={info} askContext={askContext} onResult={applyAi} />
          </Card>
        </div>
      ) : (
        <div className="ed-empty">
          <strong>Nothing selected</strong>
          <span>Click an element on the page, or pick one in the list above.</span>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------- tree

interface TreeLevelData {
  nodes: TreeNode[];
  /** Which of the `total` child elements are loaded. */
  start: number;
  end: number;
  total: number;
}

const count = (n: number) => n.toLocaleString();

function TreeLevel({ id, depth, tree, expanded, selectedId, alsoSelected, onToggle, onMore, onSelect, onHide }: { id: string; depth: number; tree: Record<string, TreeLevelData>; expanded: Set<string>; selectedId: string | null; alsoSelected: Set<string>; onToggle: (id: string) => void; onMore: (id: string, dir: 'earlier' | 'later') => void; onSelect: (id: string, add?: boolean) => void; onHide: (id: string) => void }) {
  const level = tree[id];
  if (!level) return depth ? <div className="ed-row muted" style={{ paddingLeft: 10 + depth * 14 }}>Loading…</div> : null;
  return (
    <>
      {level.start > 0 && (
        <button className="ed-more" style={{ marginLeft: 26 + depth * 14 }} onClick={() => onMore(id, 'earlier')}>
          Show earlier · {count(level.start)} above
        </button>
      )}
      {level.nodes.map((n) => {
        const open = expanded.has(n.id);
        return (
          <div key={n.id} role="none">
            <div
              role="treeitem"
              aria-selected={selectedId === n.id || alsoSelected.has(n.id)}
              aria-expanded={n.hasChildren ? open : undefined}
              data-node={n.id}
              className={['ed-row', selectedId === n.id ? 'selected' : alsoSelected.has(n.id) ? 'also' : '', n.hidden ? 'dim' : '', n.layout ? 'layout' : '', n.origin === 'webloom' ? 'ww' : ''].filter(Boolean).join(' ')}
              title={n.layout ? 'A layout element: it draws nothing itself. Shown here while it is selected.' : undefined}
              style={{ paddingLeft: 6 + depth * 14 }}
              tabIndex={selectedId === n.id ? 0 : -1}
              onClick={(e) => onSelect(n.id, e.ctrlKey || e.metaKey || e.shiftKey)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(n.id);
                } else if (e.key === 'ArrowRight' && n.hasChildren && !open) onToggle(n.id);
                else if (e.key === 'ArrowLeft' && open) onToggle(n.id);
              }}
            >
              {n.hasChildren ? (
                <button
                  className={open ? 'ed-twisty open' : 'ed-twisty'}
                  aria-label={open ? 'Collapse' : 'Expand'}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggle(n.id);
                  }}
                >
                  <ChevronIcon size={13} />
                </button>
              ) : (
                <span className="ed-twisty-space" />
              )}
              <span className="ed-kind">{n.origin === 'webloom' ? <SparkleIcon size={14} /> : <KindIcon kind={n.kind} />}</span>
              <span className="ed-label">{n.label}</span>
              {n.detail && <span className="ed-detail">{n.detail}</span>}
              {n.layout && <span className="ed-layout">layout</span>}
              {n.edited && <span className="ed-dot" title="Edited by you" />}
              {n.bg?.text ? (
                // text: an "A" in its text colour, on its background colour if it has one
                <span className={!n.bg.color ? 'ed-swatch text clear' : seeThrough(n.bg.color) ? 'ed-swatch text alpha' : 'ed-swatch text'} style={{ color: n.bg.text, ...(n.bg.color ? (seeThrough(n.bg.color) ? { '--c': markerColor(n.bg.color) } : { background: n.bg.color }) : {}) } as React.CSSProperties} title={`Text colour ${n.bg.text}${n.bg.color ? ` on ${n.bg.color}` : ''}`} aria-hidden="true">
                  A
                </span>
              ) : n.bg && (
                // its background at a glance, at the row's right end: the colour (or gradient), a picture / video, what
                // it shows inside, or see-through
                <span
                  className={n.bg.color ? (seeThrough(n.bg.color) ? 'ed-swatch alpha' : 'ed-swatch') : n.bg.transparent ? (n.bg.through ? 'ed-swatch through' : 'ed-swatch clear') : n.bg.inner ? 'ed-swatch media inner' : 'ed-swatch media'}
                  style={n.bg.color ? (seeThrough(n.bg.color) ? ({ '--c': markerColor(n.bg.color) } as React.CSSProperties) : { background: n.bg.color }) : n.bg.through ? { background: n.bg.through } : undefined}
                  title={n.bg.video ? 'Video' : n.bg.image ? 'Background picture' : n.bg.inner === 'video' ? 'No background; shows a video' : n.bg.inner ? 'No background; shows a picture' : n.bg.transparent ? `No background of its own: ${n.bg.through ?? 'see-through'} shows from behind` : `Background ${n.bg.color}`}
                  aria-hidden="true"
                >
                  {n.bg.video || n.bg.inner === 'video' ? <KindIcon kind="video" size={11} /> : n.bg.image || n.bg.inner ? <KindIcon kind="image" size={11} /> : null}
                </span>
              )}
              {/* like the browser's developer tools: hide it on the page, or show it again, without selecting it (not the page itself) */}
              {n.kind !== 'page' && <button
                className={n.hidden ? 'ed-eye off' : 'ed-eye'}
                disabled={!!n.hidden && !n.hiddenByYou}
                aria-label={n.hidden ? (n.hiddenByYou ? `Show ${n.label}` : `${n.label} is hidden by the site`) : `Hide ${n.label}`}
                title={n.hidden ? (n.hiddenByYou ? 'Show it again' : 'Hidden by the site (or inside something hidden)') : 'Hide it (its space stays)'}
                onClick={(e) => {
                  e.stopPropagation();
                  onHide(n.id);
                }}
                onKeyDown={(e) => e.stopPropagation()}
              >
                {n.hidden ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
              </button>}
            </div>
            {open && n.hasChildren && <TreeLevel id={n.id} depth={depth + 1} tree={tree} expanded={expanded} selectedId={selectedId} alsoSelected={alsoSelected} onToggle={onToggle} onMore={onMore} onSelect={onSelect} onHide={onHide} />}
          </div>
        );
      })}
      {level.end < level.total && (
        <button className="ed-more" style={{ marginLeft: 26 + depth * 14 }} onClick={() => onMore(id, 'later')}>
          Show {count(Math.min(TREE_BATCH, level.total - level.end))} more · {count(level.total - level.end)} left
        </button>
      )}
    </>
  );
}

// ------------------------------------------------------------------------------------------- Options

type Patch = Record<string, string | null>;
type ChangeOpts = { text?: string | null; all?: string | null; slot?: Slot };
type Change = (patch: Patch, label: string, opts?: ChangeOpts) => void;
type Preview = (patch: Patch, slot?: Slot) => void;
type PartPatch = { patch: Patch; slot?: Slot };
type ChangePart = (part: PartInfo, sets: PartPatch[], label: string) => void;
type PreviewPart = (part: PartInfo, sets: PartPatch[]) => void;

function OptionsPane({ info, val, change, preview, changePart, previewPart, host, setError, send, showLook, look, onHoverTab }: { info: SelectionInfo; val: (p: string) => string; change: Change; preview: Preview; changePart: ChangePart; previewPart: PreviewPart; host: string; setError: (s: string) => void; send: (m: ToPage) => void; showLook: (s: EditState) => void; look: EditState; onHoverTab?: () => void }) {
  const borderGrad = currentGradient('border', val);
  const bordered = parseFloat(val('border-top-width')) > 0 && val('border-top-style') !== 'none';
  const k = info.kind;
  // only an icon (by itself, or a button or link with no words): its colour is in the Icon card, not Typography
  const iconOnly = !!info.parts.icon && info.words === false;
  const textish = (k === 'text' || k === 'heading' || k === 'link' || k === 'button') && !iconOnly;
  const container = k === 'box' || k === 'section' || k === 'list' || k === 'page' || k === 'field' || k === 'video';
  const deco = k === 'decoration' || !!info.pseudo;
  const typography = (textish || k === 'field') && !deco && (
    <Group title="Typography">
      <Row label="Font">
        <select value={matchFont(val('font-family'))} onChange={(e) => change({ 'font-family': e.target.value === '' ? null : e.target.value }, 'Font')}>
          <option value="">As the theme has it</option>
          <optgroup label="Google Fonts">
            {GOOGLE_FONTS.map((f) => (
              <option key={f} value={`'${f}', serif`}>
                {f}
              </option>
            ))}
          </optgroup>
          <optgroup label="System">
            <option value="Georgia, serif">Georgia</option>
            <option value="system-ui, sans-serif">System sans</option>
            <option value="ui-monospace, monospace">Monospace</option>
          </optgroup>
        </select>
      </Row>
      <NumRow label="Size" unit="px" prop="font-size" val={val} change={change} min={6} max={160} />
      <Row label="Weight">
        <select value={String(Math.round(Number(val('font-weight')) / 100) * 100 || 400)} onChange={(e) => change({ 'font-weight': e.target.value }, 'Weight')}>
          {[300, 400, 500, 600, 700, 800, 900].map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
      </Row>
      <ColorRow label="Text colour" prop="color" val={val} change={change} preview={preview} gradient="text" fit={textFit(info, val)} note="The text shows the gradient through itself, so a background of its own is not shown." />
      <NumRow label="Line height" prop="line-height" val={val} change={change} min={0.6} max={4} step={0.05} unitless />
      <NumRow label="Letter spacing" unit="px" prop="letter-spacing" val={(p) => (val(p) === 'normal' ? '0' : val(p))} change={change} min={-5} max={30} step={0.5} />
      <Row label="Align">
        <Seg value={val('text-align').replace('start', 'left')} options={['left', 'center', 'right', 'justify']} onPick={(v) => change({ 'text-align': v }, 'Alignment')} />
      </Row>
      <Row label="Style">
        <span className="ed-inline">
          <label className="art-check">
            <input type="checkbox" checked={val('font-style') === 'italic'} onChange={(e) => change({ 'font-style': e.target.checked ? 'italic' : 'normal' }, 'Italic')} />
            <span>Italic</span>
          </label>
          <select value={val('text-decoration-line') || 'none'} onChange={(e) => change({ 'text-decoration': e.target.value }, 'Decoration')}>
            <option value="none">No line</option>
            <option value="underline">Underline</option>
            <option value="line-through">Strike through</option>
          </select>
          <select value={val('text-transform') || 'none'} onChange={(e) => change({ 'text-transform': e.target.value }, 'Case')}>
            <option value="none">Aa</option>
            <option value="uppercase">AA</option>
            <option value="lowercase">aa</option>
            <option value="capitalize">Aa Bb</option>
          </select>
        </span>
      </Row>
    </Group>
  );
  return (
    <div className="ed-options">
      {/* a layer always over it (a dark tint on a button): first, as it is what people see over the element */}
      {/* Normal edits only what shows normally: an overlay over it all the time. A hover overlay is edited in Hover only */}
      {info.parts.overlay && alwaysOn(info.parts.overlay) && <OverlayGroup part={info.parts.overlay} changePart={changePart} previewPart={previewPart} showLook={showLook} look={look} send={send} slot={null} />}
      {info.parts.overlay && !alwaysOn(info.parts.overlay) && info.states.includes('hover') && onHoverTab && (
        <p className="hint ed-hover-note">
          It has a hover overlay.{' '}
          <button className="link-btn" onClick={onHoverTab}>
            Edit it in Hover
          </button>
        </p>
      )}
      <Group title="Appearance">
        {currentGradient('text', val) ? (
          <p className="hint">The background shows through the text gradient. Make the text one colour to give it a background.</p>
        ) : (
          <ColorRow label="Background" prop="background-color" val={val} change={change} preview={preview} clear gradient="background" />
        )}
        {(info.kind === 'box' || info.kind === 'section' || info.kind === 'list' || info.kind === 'page' || info.kind === 'decoration' || info.kind === 'text' || info.kind === 'heading' || info.kind === 'button' || info.kind === 'link') && <BackgroundImage host={host} info={info} change={change} setError={setError} />}
        <SliderRow label="Opacity" prop="opacity" val={val} change={change} preview={preview} min={0} max={100} toCss={(v) => String(v / 100)} fromCss={(s) => Math.round((parseFloat(s) || (s === '0' ? 0 : 1)) * 100)} suffix="%" />
        <SliderRow label="Corners" prop="border-radius" val={(p) => (p === 'border-radius' ? val('border-top-left-radius') : val(p))} change={change} preview={preview} min={0} max={80} toCss={(v) => `${v}px`} fromCss={(s) => parseFloat(s) || 0} suffix="px" />
        <Row label="Border">
          <span className="ed-inline">
            <input className="ed-num" type="number" min={0} max={40} value={px(info.editCss['border-width'] ?? val('border-top-width'))} aria-label="Border width" onChange={(e) => change({ 'border-width': `${e.target.value || 0}px`, 'border-style': val('border-top-style') === 'none' ? 'solid' : val('border-top-style') }, 'Border width')} />
            <select value={val('border-top-style') || 'none'} aria-label="Border style" onChange={(e) => change({ 'border-style': e.target.value }, 'Border style')}>
              {['none', 'solid', 'dashed', 'dotted', 'double'].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            {!borderGrad && <ColorInput aria-label="Border colour" value={toHex(val('border-top-color'))} onPreview={(v) => preview({ 'border-color': v })} onCommit={(v) => change({ 'border-color': v }, 'Border colour')} />}
            <GradientToggle on={!!borderGrad} label="Border" disabled={!bordered} onToggle={() => change(gradientPatch('border', borderGrad ? null : startGradient(toHex(val('border-top-color')))), borderGrad ? 'Border: solid' : 'Border gradient')} />
          </span>
        </Row>
        {borderGrad && <GradientEditor g={borderGrad} label="Border" note="A gradient border has square corners." onPreview={(n) => preview(gradientPatch('border', n))} onChange={(n, what) => change(gradientPatch('border', n), `Border gradient ${what}`)} />}
        <Row label="Shadow">
          <select value={SHADOWS.find(([v]) => v === info.editCss['box-shadow'])?.[0] ?? ''} onChange={(e) => change({ 'box-shadow': e.target.value || null }, 'Shadow')}>
            <option value="">As the theme has it</option>
            {SHADOWS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Row>
        {deco && <SliderRow label="Scale" prop="scale" val={val} change={change} preview={preview} min={20} max={300} toCss={(v) => String(v / 100)} fromCss={(s) => Math.round((s === 'none' || !s ? 1 : parseFloat(s)) * 100)} suffix="%" />}
      </Group>
      {info.caps.text && !iconOnly && (
        <Group title="Text">
          <TextField value={info.editText ?? info.text ?? ''} onCommit={(t) => change({}, 'Edit text', { text: t === (info.text ?? '') && info.editText === undefined ? undefined : t })} />
          {info.editText !== undefined && !info.added && (
            <button className="link-btn" onClick={() => change({}, 'Original text', { text: null })}>
              Use the site’s original text
            </button>
          )}
        </Group>
      )}
      {typography}
      {info.parts.icon && <IconGroup part={info.parts.icon} isSelf={info.parts.icon.id === info.id} changePart={changePart} previewPart={previewPart} host={host} setError={setError} send={send} />}
      <FieldExtras info={info} val={val} change={change} preview={preview} />
      <ListBullets info={info} val={val} change={change} preview={preview} />
      {(k === 'image' || k === 'video') && !(info.parts.icon && info.parts.icon.id === info.id) && <ImageLook val={val} change={change} />}
      {info.caps.resize && (
        <Group title="Size">
          <NumRow label="Width" unit="px" prop="width" val={val} change={(p, l) => change({ ...p, 'max-width': 'none' }, l)} min={1} max={4000} />
          <NumRow label="Height" unit="px" prop="height" val={val} change={change} min={1} max={4000} />
          {k === 'image' && (
            <>
              <Row label="Fit">
                <select value={val('object-fit') || 'fill'} onChange={(e) => change({ 'object-fit': e.target.value }, 'Fit')}>
                  <option value="cover">Fill and crop</option>
                  <option value="contain">Show it all</option>
                  <option value="fill">Stretch</option>
                  <option value="none">Original size</option>
                  <option value="scale-down">Shrink only</option>
                </select>
              </Row>
              <Row label="Focus">
                <select value={val('object-position')} onChange={(e) => change({ 'object-position': e.target.value }, 'Crop focus')}>
                  {['50% 50%', '50% 0%', '50% 100%', '0% 50%', '100% 50%'].map((v, i) => (
                    <option key={v} value={v}>
                      {['Centre', 'Top', 'Bottom', 'Left', 'Right'][i]}
                    </option>
                  ))}
                </select>
              </Row>
            </>
          )}
          {(info.editCss.width || info.editCss.height) && (
            <button className="link-btn" onClick={() => change({ width: null, height: null, 'max-width': null }, 'Original size')}>
              Original size
            </button>
          )}
        </Group>
      )}
      {info.caps.image && <ReplaceImage host={host} onToken={(token) => change({ content: `url("${token}")`, 'object-fit': val('object-fit') === 'fill' ? 'cover' : val('object-fit') }, 'Replace image')} hasReplacement={!!info.editCss.content} onRestore={() => change({ content: null }, 'Original image')} setError={setError} />}
      {/* every element can take room inside and around it (buttons, links, text, pictures too), not only boxes */}
      {!deco && (
        <Group title="Spacing">
          <BoxRow label="Padding" prop="padding" val={val} change={change} />
          <BoxRow label="Margin" prop="margin" val={val} change={change} />
        </Group>
      )}
      {container && !deco && k !== 'video' && k !== 'field' && (
        <Group title="Layout">
          <Row label="Display">
            <select value={val('display')} onChange={(e) => change({ display: e.target.value }, 'Display')}>
              {['block', 'flex', 'grid', 'inline-block', 'inline-flex', 'inline'].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </Row>
          {/flex/.test(val('display')) && (
            <>
              <Row label="Direction">
                <Seg value={val('flex-direction')} options={['row', 'column']} onPick={(v) => change({ 'flex-direction': v }, 'Direction')} />
              </Row>
              <Row label="Wrap">
                <Seg value={val('flex-wrap')} options={['nowrap', 'wrap']} onPick={(v) => change({ 'flex-wrap': v }, 'Wrap')} />
              </Row>
              <Row label="Justify">
                <select value={val('justify-content')} onChange={(e) => change({ 'justify-content': e.target.value }, 'Justify')}>
                  {['normal', 'flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'].map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label="Align">
                <select value={val('align-items')} onChange={(e) => change({ 'align-items': e.target.value }, 'Align')}>
                  {['normal', 'stretch', 'flex-start', 'center', 'flex-end', 'baseline'].map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </Row>
            </>
          )}
          {/grid/.test(val('display')) && (
            <Row label="Columns">
              <select value={/^repeat\((\d)/.exec(info.editCss['grid-template-columns'] ?? '')?.[1] ?? ''} onChange={(e) => change({ 'grid-template-columns': e.target.value ? `repeat(${e.target.value}, minmax(0, 1fr))` : null }, 'Columns')}>
                <option value="">As the site has it</option>
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </Row>
          )}
          {/flex|grid/.test(val('display')) && <NumRow label="Gap" unit="px" prop="gap" val={(p) => (val(p) === 'normal' ? '0' : val(p))} change={change} min={0} max={200} />}
          <Row label="Overflow">
            <select value={val('overflow')} onChange={(e) => change({ overflow: e.target.value }, 'Overflow')}>
              {['visible', 'hidden', 'auto', 'clip'].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Row>
        </Group>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------- hover / focus looks

function StatePane({ info, state, val, change, preview, changePart, previewPart, showLook, send }: { info: SelectionInfo; state: EditState; val: (p: string) => string; change: Change; preview: Preview; changePart: ChangePart; previewPart: PreviewPart; showLook: (s: EditState) => void; send: (m: ToPage) => void; host: string; setError: (s: string) => void }) {
  const slot = state as Slot;
  const mine = info.editSlots[slot] ?? {};
  const sv = (p: string) => mine[p] ?? val(p);
  const ch: Change = (patch, label) => change(patch, `${label} (${state})`, { slot });
  const pv: Preview = (patch) => preview(patch, slot);
  const k = info.kind;
  const textish = ['text', 'heading', 'link', 'button', 'field', 'box'].includes(k) && !(info.parts.icon && info.words === false); // only an icon: its hover colour is in the Icon group
  const bordered = parseFloat(val('border-top-width')) > 0 && val('border-top-style') !== 'none';
  return (
    <div className="ed-options">
      {state === 'hover' && info.parts.overlay && <OverlayGroup part={info.parts.overlay} changePart={changePart} previewPart={previewPart} showLook={showLook} look={state} send={send} />}
      {/* with an overlay, two cards change the hover look: the overlay (a layer on top) and the element itself (under it) */}
      <Group title={state === 'hover' ? (info.parts.overlay ? `${itselfName(k)}, while pointed at` : 'While pointed at') : 'While focused'}>
        {textish && <ColorRow label="Text colour" prop="color" val={sv} change={ch} preview={pv} gradient="text" fit={textFit(info, sv)} />}
        {currentGradient('text', sv) ? (
          <p className="hint">The background shows through the text gradient.</p>
        ) : (
          <ColorRow label="Background" prop="background-color" val={sv} change={ch} preview={pv} clear gradient="background" />
        )}
        {bordered ? (
          <ColorRow label="Border colour" prop="border-color" val={(p) => mine[p] ?? (p === 'border-color' ? val('border-top-color') : val(p))} change={ch} preview={pv} gradient="border" note="A gradient border has square corners." />
        ) : (
          <ColorRow label={state === 'focus' ? 'Focus ring' : 'Outline'} prop="outline-color" val={(p) => mine[p] ?? ''} change={(patch, l) => ch({ ...patch, 'outline-style': 'solid', 'outline-width': state === 'focus' ? '3px' : '2px', 'outline-offset': '2px' }, l)} preview={(patch) => pv({ ...patch, 'outline-style': 'solid', 'outline-width': '2px', 'outline-offset': '2px' })} />
        )}
        {(k === 'link' || k === 'text' || k === 'heading' || k === 'button') && (
          <Row label="Underline">
            <select value={mine['text-decoration-line'] ?? ''} onChange={(e) => ch({ 'text-decoration-line': e.target.value || null }, 'Underline')}>
              <option value="">As normal</option>
              <option value="underline">Underline</option>
              <option value="none">No underline</option>
            </select>
          </Row>
        )}
        <Row label="Shadow">
          <select value={SHADOWS.find(([v]) => v === mine['box-shadow'])?.[0] ?? ''} onChange={(e) => ch({ 'box-shadow': e.target.value || null }, 'Shadow')}>
            <option value="">As normal</option>
            {SHADOWS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Row>
        <SliderRow label="Opacity" prop="opacity" val={sv} change={ch} preview={pv} min={0} max={100} toCss={(v) => String(v / 100)} fromCss={(s) => Math.round((parseFloat(s) || (s === '0' ? 0 : 1)) * 100)} suffix="%" />
        <SliderRow label="Grow" prop="scale" val={sv} change={ch} preview={pv} min={80} max={130} toCss={(v) => String(v / 100)} fromCss={(s) => Math.round((s === 'none' || !s ? 1 : parseFloat(s)) * 100)} suffix="%" />
        {Object.keys(mine).length > 0 && (
          <button className="link-btn" onClick={() => change(Object.fromEntries(Object.keys(mine).map((p) => [p, null])), `Clear the ${state} look`, { slot })}>
            Clear the {state} look
          </button>
        )}
      </Group>
      {state === 'hover' && info.parts.icon && <IconColour part={info.parts.icon} slot="hover" changePart={changePart} previewPart={previewPart} />}
    </div>
  );
}

/**
 * A colour picker that saves once. React's onChange on a colour input fires on every step of a drag, which saved
 * each passing colour as its own change (the page then played them all back). Dragging only previews; the browser's
 * own "change" event (the picker closed or the colour settled) saves. The colour being picked is held here until the
 * saved one comes back, so the swatch cannot jump back to an older value in between.
 */
function ColorInput({ value, onPreview, onCommit, disabled, ...aria }: { value: string; onPreview?: (v: string) => void; onCommit: (v: string) => void; disabled?: boolean; 'aria-label'?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  const saved = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const done = () => {
      saved.current = true;
      commit.current(el.value);
    };
    el.addEventListener('change', done);
    return () => el.removeEventListener('change', done);
  }, []);
  // the saved colour came back: show what the page has again
  useEffect(() => {
    if (saved.current) {
      saved.current = false;
      setDraft(null);
    }
  }, [value]);
  return (
    <input
      ref={ref}
      type="color"
      className="ed-color"
      {...aria}
      disabled={disabled}
      value={draft ?? value}
      onChange={(e) => {
        setDraft(e.target.value);
        onPreview?.(e.target.value);
      }}
    />
  );
}

// ------------------------------------------------------------------------------------------- icons

const keepable = (p: PartInfo) => p.base.target.selectors.length > 0 || !!p.base.target.all;
const MASK_KEYS = ['mask-image', '-webkit-mask-image', 'mask-size', '-webkit-mask-size', 'mask-position', '-webkit-mask-position', 'mask-repeat', '-webkit-mask-repeat'];
const REPLACE_KEYS = [...MASK_KEYS, 'background-color', 'background-image', 'background-size', 'background-position', 'background-repeat', 'content', 'object-position', '-webkit-text-fill-color'];
const clearReplace = (): Patch => Object.fromEntries(REPLACE_KEYS.map((k) => [k, null]));

/** The changes that give an icon a colour (normal, or on hover). An SVG's shapes are made to follow `color`. */
function colourSets(part: PartInfo, c: string, slot?: Slot): PartPatch[] {
  const sets: PartPatch[] = [];
  if (part.iconType === 'svg') {
    const root: Patch = {};
    for (const p of part.paint?.root ?? []) if (p !== 'color') root[p] = 'currentColor';
    if (!slot) root.color = c;
    sets.push({ patch: root });
    const shapes: Patch = {};
    for (const p of part.paint?.shapes ?? []) shapes[p] = 'currentColor';
    if (Object.keys(shapes).length) sets.push({ patch: shapes, slot: 'shapes' });
  } else if (!slot) sets.push({ patch: { color: c } });
  if (slot) sets.push({ patch: { color: c }, slot });
  return sets;
}

function IconColour({ part, slot, changePart, previewPart }: { part: PartInfo; slot?: Slot; changePart: ChangePart; previewPart: PreviewPart }) {
  const cur = slot ? part.editSlots[slot]?.color : part.editCss.color;
  const colourable = part.iconType !== 'img' || !!part.editCss['mask-image'];
  const label = slot ? 'Icon on hover' : 'Colour';
  if (!colourable) return slot ? null : <p className="hint">This icon is a picture, so it has its own colours. Pick a new icon below to colour it.</p>;
  // a gradient paints an icon drawn as a mask (a picked icon) or as text (an icon font). A site's SVG draws its own
  // shapes: for a gradient its shape is made a mask (its own picture), and its shapes are hidden under it
  const maskNow = part.editCss['mask-image'] || part.editCss['-webkit-mask-image'];
  const masked = !!maskNow;
  const ownShape = part.iconType === 'svg' && masked && !iconInMask(maskNow);
  const canMask = !slot && part.iconType === 'svg' && !masked && !!part.svgMask;
  const canGrad = masked || part.iconType === 'font' || canMask;
  const mineSet = (slot ? part.editSlots[slot] : part.editCss) ?? {};
  const g = canGrad ? parseGradient(mineSet['background-image']) : null;
  const gradSets = (n: Gradient | null): PartPatch[] => {
    if (canMask && n) {
      const mask: Patch = {};
      for (const pre of ['', '-webkit-']) Object.assign(mask, { [`${pre}mask-image`]: `url("${part.svgMask}")`, [`${pre}mask-size`]: 'contain', [`${pre}mask-position`]: 'center', [`${pre}mask-repeat`]: 'no-repeat' });
      return [{ patch: { ...mask, 'background-color': 'transparent', 'background-image': gradientCss(n) } }, { patch: { visibility: 'hidden' }, slot: 'shapes' }];
    }
    // back to solid: the site's own shapes again (the mask was only there for the gradient)
    if (ownShape && !n && !slot) return [{ patch: clearReplace() }, { patch: { visibility: null }, slot: 'shapes' }];
    return [{ patch: masked ? { 'background-image': n ? gradientCss(n) : null } : gradientPatch('text', n), slot }];
  };
  const field = (
    <>
    <Row label={label}>
      <span className="ed-inline">
        {!g && <ColorInput aria-label={slot ? 'Icon colour on hover' : 'Icon colour'} value={toHex(cur ?? part.computed.color)} disabled={!keepable(part)} onPreview={(v) => previewPart(part, colourSets(part, v, slot))} onCommit={(v) => changePart(part, colourSets(part, v, slot), slot ? 'Icon colour on hover' : 'Icon colour')} />}
        <span className="hint ed-val">{g ? 'Gradient' : cur ? toHex(cur) : 'as is'}</span>
        {canGrad && <GradientToggle on={!!g} label="Icon" disabled={!keepable(part)} onToggle={() => changePart(part, gradSets(g ? null : startGradient(toHex(cur ?? part.computed.color))), g ? 'Icon: solid' : 'Icon gradient')} />}
        {cur && !g && (
          <button className="link-btn" onClick={(e) => (e.preventDefault(), changePart(part, [{ patch: { color: null }, slot }], slot ? 'Icon hover colour off' : 'Original icon colour'))}>
            Clear
          </button>
        )}
      </span>
    </Row>
    {g && <GradientEditor g={g} label="Icon" onPreview={(n) => previewPart(part, gradSets(n))} onChange={(n, what) => changePart(part, gradSets(n), `Icon gradient ${what}`)} />}
    {!canGrad && !slot && <p className="hint">This icon is drawn from elsewhere on the page, so it cannot take a gradient. Pick one of the icons below for a gradient.</p>}
    </>
  );
  return slot ? <Group title="Icon">{field}</Group> : field;
}

function IconGroup({ part, isSelf, changePart, previewPart, host, setError, send }: { part: PartInfo; isSelf: boolean; changePart: ChangePart; previewPart: PreviewPart; host: string; setError: (s: string) => void; send: (m: ToPage) => void }) {
  const t = part.iconType ?? 'svg';
  const css = part.editCss;
  const replaced = REPLACE_KEYS.some((k) => k !== 'background-color' && css[k]);
  const current = iconInMask(css['mask-image']);
  const [open, setOpen] = useState(false);
  const [filled, setFilled] = useState(current?.filled ?? false);
  const [busy, setBusy] = useState(false);
  const [find, setFind] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const keep = keepable(part);
  const sizeNow = Math.round(parseFloat(t === 'font' ? part.computed['font-size'] : part.computed.width) || 24);
  const ratio = (parseFloat(part.computed.height) || 1) / (parseFloat(part.computed.width) || 1);
  const useIcon = (name: string, fill = filled) => {
    const u = iconUrl(name, fill);
    if (!u) return;
    // longhands: the shorthand with an embedded picture is longer than one declaration may be
    const mask: Patch = {};
    for (const pre of ['', '-webkit-']) Object.assign(mask, { [`${pre}mask-image`]: `url("${u}")`, [`${pre}mask-size`]: 'contain', [`${pre}mask-position`]: 'center', [`${pre}mask-repeat`]: 'no-repeat' });
    const self: Patch = { ...clearReplace(), ...mask, 'background-color': 'currentColor', ...(t === 'font' ? { '-webkit-text-fill-color': 'transparent' } : t === 'img' ? { 'object-position': '-99999px 0' } : {}) };
    changePart(part, [{ patch: self }, ...(t === 'svg' ? [{ patch: { visibility: 'hidden' }, slot: 'shapes' as Slot }] : [])], 'Change icon');
  };
  const usePicture = async (file: File) => {
    setBusy(true);
    try {
      const token = await storePicture(host, file);
      if (!token) return;
      const self: Patch = t === 'img' ? { ...clearReplace(), content: `url("${token}")` } : { ...clearReplace(), 'background-image': `url("${token}")`, 'background-size': 'contain', 'background-position': 'center', 'background-repeat': 'no-repeat', ...(t === 'font' ? { '-webkit-text-fill-color': 'transparent' } : {}) };
      changePart(part, [{ patch: self }, ...(t === 'svg' ? [{ patch: { visibility: 'hidden' }, slot: 'shapes' as Slot }] : [])], 'Icon picture');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That image could not be used.');
    } finally {
      setBusy(false);
    }
  };
  const original = () => changePart(part, [{ patch: clearReplace() }, ...(t === 'svg' ? [{ patch: { visibility: null }, slot: 'shapes' as Slot }] : [])], 'Original icon');
  return (
    <Group title={isSelf ? 'Icon' : 'Icon inside it'}>
      {!keep && <p className="hint">This icon cannot be found again after a reload, so changes to it cannot be kept. Try selecting the icon itself.</p>}
      <IconColour part={part} changePart={changePart} previewPart={previewPart} />
      <Row label="Size">
        <span className="ed-inline">
          <SideInput side="Icon size (px)" value={String(sizeNow)} onCommit={(n) => keep && n > 0 && changePart(part, [{ patch: t === 'font' ? { 'font-size': `${Math.min(200, n)}px` } : { width: `${Math.min(400, n)}px`, height: `${Math.round(Math.min(400, n) * ratio)}px`, 'min-width': `${Math.min(400, n)}px` } }], 'Icon size')} />
          <span className="hint">px</span>
        </span>
      </Row>
      <div className="ed-inline">
        <button className="ghost small-btn" aria-expanded={open} disabled={!keep} onClick={() => setOpen((o) => !o)}>
          {open ? 'Close icons' : replaced ? 'Change icon…' : 'Pick a new icon…'}
        </button>
        <button className="ghost small-btn" disabled={!keep || busy} onClick={() => input.current?.click()}>
          {busy ? 'Adding…' : 'Your picture…'}
        </button>
        {replaced && (
          <button className="link-btn" onClick={original}>
            Use the original
          </button>
        )}
      </div>
      {open && (
        <div className="ed-icons">
          <label className="art-check">
            <input type="checkbox" checked={filled} onChange={(e) => { setFilled(e.target.checked); if (current) useIcon(current.name, e.target.checked); }} />
            <span>Filled in</span>
          </label>
          <input type="search" className="ed-icon-find" placeholder="Find an icon (cart, arrow, heart…)" aria-label="Find an icon" value={find} onChange={(e) => setFind(e.target.value)} />
          {(() => {
            const hits = iconMatches(find);
            const label = (n: string) => ICON_SET.find(([m]) => m === n)?.[1] ?? n;
            const groups = ICON_GROUPS.map((g) => ({ ...g, names: hits ? g.names.filter((n) => hits.has(n)) : g.names })).filter((g) => g.names.length);
            if (!groups.length) return <p className="hint">No icon matches. Try another word, or use your own picture.</p>;
            return groups.map((g) => (
              <div key={g.title} className="ed-icon-group">
                {!hits && <span className="ed-icon-head">{g.title}</span>}
                <div className="ed-icon-grid" role="listbox" aria-label={`${g.title} icons`}>
                  {g.names.map((name) => (
                    <button key={name} role="option" aria-selected={current?.name === name} className={current?.name === name ? 'ed-icon on' : 'ed-icon'} title={filled && !canFill(name) ? `${label(name)} (stays as lines)` : label(name)} aria-label={label(name)} onClick={() => useIcon(name)}>
                      <span className="ed-icon-shape" style={{ WebkitMaskImage: `url("${iconUrl(name, filled)}")`, maskImage: `url("${iconUrl(name, filled)}")` }} />
                    </button>
                  ))}
                </div>
              </div>
            ));
          })()}
          <p className="hint">The new icon takes the icon’s colour, also on hover.</p>
        </div>
      )}
      {!isSelf && (
        <button className="link-btn" onClick={() => send({ t: 'select', id: part.id })}>
          Select the icon itself
        </button>
      )}
      <input ref={input} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void usePicture(f); }} />
    </Group>
  );
}

// ------------------------------------------------------------------------------------------- hover overlay

const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.round(a * 100) / 100})`;
};
/** How opaque a colour is (0 to 1). Only a fourth value is its opacity: rgb(204, 136, 68) is solid, not 68. */
const alphaOf = (css: string) => {
  const c = (css || '').trim().toLowerCase();
  if (!c) return 1; // not known: as before, solid
  if (c === 'transparent') return 0;
  const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(c);
  if (slash) return slash[2] ? Number(slash[1]) / 100 : Number(slash[1]);
  const rgba = /^rgba?\(([^)]*)\)$/.exec(c);
  if (rgba) {
    const parts = rgba[1].split(',');
    if (parts.length === 4) return Math.min(1, Math.max(0, Number(parts[3]) || 0));
  }
  return 1;
};
const OVERLAY_SHAPES: [string, string][] = [['', 'As is'], ['0px', 'Square'], ['10px', 'Rounded'], ['999px', 'Pill'], ['50%', 'Circle']];

/** "The button itself": the card for the element's own hover look, told apart from its overlay's. */
const itselfName = (k: string) => (k === 'button' ? 'The button itself' : k === 'link' ? 'The link itself' : 'The element itself');

/** Does the overlay show right now, without pointing at it (a dark layer always over a button)? */
const overlayShowsNow = (part: PartInfo) => (parseFloat(part.computed.opacity || '1') || 0) > 0.02 && alphaOf(part.computed['background-color'] || 'transparent') > 0.02;
/**
 * An overlay over it all the time (edited as the Normal look), not only on hover. Measured while the pointer was on
 * the element (it was just clicked), what shows may be the site's hover look: then it counts as a hover overlay.
 */
const alwaysOn = (part: PartInfo) => !!part.editCss['background-color'] || (!part.hovered && overlayShowsNow(part));

/**
 * The layer a button draws over itself. slot "hover": the Hover overlay (the Hover tab). No slot: an overlay that shows
 * all the time (the Normal tab), with its colour and strength as the page has them now.
 */
function OverlayGroup({ part, changePart, previewPart, showLook, look, send, slot = 'hover' }: { part: PartInfo; changePart: ChangePart; previewPart: PreviewPart; showLook: (s: EditState) => void; look: EditState; send: (m: ToPage) => void; slot?: Slot | null }) {
  const hoverOnly = slot === 'hover';
  const hov = (hoverOnly ? part.editSlots.hover : part.editCss) ?? {};
  // the always-shown overlay starts from what the page shows (its colour and how strong it is)
  // (the hover one too, when it was measured while pointed at: then the page showed the site's hover look)
  const siteNow = !hoverOnly || (part.hovered && overlayShowsNow(part)) ? rgba(toHex(part.computed['background-color'] || '#000000'), alphaOf(part.computed['background-color'] || 'transparent') * (parseFloat(part.computed.opacity || '1') || 0)) : '';
  // hidden right now (YouTube's layer shows only when pressed or focused): as the site's own rules show it, its colour
  // at the strength they give it, so the site's overlay is what is edited, not a new one
  const stLook = part.stateLook;
  const lookColour = stLook?.color ?? part.computed['background-color'] ?? '';
  const siteShown = !siteNow && hoverOnly && stLook && alphaOf(lookColour || 'transparent') > 0 ? rgba(toHex(lookColour), alphaOf(lookColour) * (stLook.opacity ?? (parseFloat(part.computed.opacity || '1') || 1))) : '';
  const now = !hov['background-color'] ? siteNow || siteShown : '';
  const cur = hov['background-color'] ?? now;
  const [hex, setHex] = useState(toHex(cur || '#000000'));
  const firstStop = parseGradient(hov['background-image'])?.stops[0];
  const [alpha, setAlpha] = useState(firstStop ? alphaOf(firstStop) : cur && !transparent(cur) ? alphaOf(cur) : 0.15);
  useEffect(() => {
    setHex(toHex(firstStop || cur || '#000000'));
    setAlpha(firstStop ? alphaOf(firstStop) : cur && !transparent(cur) ? alphaOf(cur) : 0.15);
  }, [cur, firstStop]);
  const keep = keepable(part);
  const grad = parseGradient(hov['background-image']);
  // a gradient overlay keeps the strength in each colour, like the solid one
  const tint = (g: Gradient, a: number): Gradient => ({ ...g, stops: g.stops.map((c) => rgba(toHex(c), a)) });
  const into = hoverOnly ? 'hover' : undefined;
  // the element around it (its own background is the hover look): its opacity is left alone, it would fade the button
  const op: Patch = part.around ? {} : { opacity: '1' };
  const sets = (h: string, a: number): PartPatch[] => [{ patch: grad ? { 'background-image': gradientCss(tint(grad, a)), 'background-color': 'transparent', ...op } : { 'background-color': rgba(h, a), 'background-image': null, ...op }, slot: into }];
  const gradSets = (g: Gradient | null): PartPatch[] => [{ patch: g ? { 'background-image': gradientCss(tint(g, alpha)), 'background-color': 'transparent', ...op } : { 'background-image': null, 'background-color': rgba(hex, alpha), ...op }, slot: into }];
  const radius = part.editCss['border-radius'] ?? '';
  const spread = part.editCss.inset ? -Math.round(parseFloat(part.editCss.inset)) : 0;
  const [sp, setSp] = useState(spread);
  useEffect(() => setSp(spread), [spread]);
  const changed = Object.keys(hov).length > 0 || !!radius || !!part.editCss.inset;
  // shown on the Hover tab only, where the page already shows the hover look: no peeking (it stayed on after leaving
  // the tab, so the hover look stayed on the page in Normal)
  const peek = {};
  return (
    <section className="ed-group" {...peek}>
      <h3>{hoverOnly ? 'Hover overlay' : 'Overlay'}</h3>
      <p className="hint">{hoverOnly ? 'A see-through layer on top of it that appears when it is pointed at. Everything about the layer is here: its colour, how see-through it is, its shape and size.' : 'A see-through layer on top of it all the time (it tints what is under it).'}</p>
      {!keep && <p className="hint">This overlay cannot be found again after a reload, so changes to it cannot be kept.</p>}
      <Row label="Colour">
        <span className="ed-inline">
          {!grad && <ColorInput aria-label="Overlay colour" value={hex} disabled={!keep} onPreview={(v) => { setHex(v); previewPart(part, sets(v, alpha)); }} onCommit={(v) => changePart(part, sets(v, alpha), 'Overlay colour')} />}
          <span className="hint ed-val">{grad ? 'Gradient' : cur ? hex : 'as the site has it'}</span>
          <GradientToggle on={!!grad} label="Overlay" disabled={!keep} onToggle={() => changePart(part, gradSets(grad ? null : startGradient(hex === '#000000' ? '' : hex)), grad ? 'Overlay: solid' : 'Overlay gradient')} />
        </span>
      </Row>
      {grad && <GradientEditor g={{ ...grad, stops: grad.stops.map((c) => toHex(c)) }} label="Overlay" onPreview={(n) => previewPart(part, gradSets(n))} onChange={(n, what) => changePart(part, gradSets(n), `Overlay gradient ${what}`)} />}
      <Row label="Opacity">
        <span className="ed-inline ed-slider">
          <input type="range" min={0} max={100} value={Math.round(alpha * 100)} aria-label="Overlay opacity" disabled={!keep} onChange={(e) => { const a = Number(e.target.value) / 100; setAlpha(a); previewPart(part, sets(hex, a)); }} onPointerUp={() => changePart(part, sets(hex, alpha), 'Overlay opacity')} onKeyUp={() => changePart(part, sets(hex, alpha), 'Overlay opacity')} />
          <span className="hint ed-val">{Math.round(alpha * 100)}%</span>
        </span>
      </Row>
      <Row label="Shape">
        <Choice value={OVERLAY_SHAPES.some(([v]) => v === radius) ? radius : ''} options={OVERLAY_SHAPES} onPick={(v) => keep && changePart(part, [{ patch: { 'border-radius': v || null } }], 'Overlay shape')} />
      </Row>
      {!part.around && <Row label="Size">
        <span className="ed-inline ed-slider">
          <input type="range" min={-12} max={16} value={sp} aria-label="Overlay size (grow or shrink around it)" disabled={!keep} onChange={(e) => { const v = Number(e.target.value); setSp(v); previewPart(part, [{ patch: { inset: v ? `${-v}px` : null } }]); }} onPointerUp={() => changePart(part, [{ patch: { inset: sp ? `${-sp}px` : null } }], 'Overlay size')} onKeyUp={() => changePart(part, [{ patch: { inset: sp ? `${-sp}px` : null } }], 'Overlay size')} />
          <span className="hint ed-val">{sp > 0 ? `+${sp}` : sp}px</span>
        </span>
      </Row>}
      <div className="ed-inline">
        <button className="link-btn" disabled={!keep} onClick={() => changePart(part, [{ patch: part.around ? { 'background-color': 'transparent', 'background-image': 'none' } : { 'background-color': 'transparent', opacity: '0' }, slot: into }], hoverOnly ? 'No hover overlay' : 'No overlay')}>
          No overlay
        </button>
        {changed && (
          <button className="link-btn" onClick={() => changePart(part, [{ patch: Object.fromEntries(Object.keys(hov).map((p) => [p, null])), slot: into }, { patch: { 'border-radius': null, inset: null } }], hoverOnly ? 'Site’s hover overlay' : 'Site’s overlay')}>
            Use the site’s
          </button>
        )}
        <button className="link-btn" onClick={() => send({ t: 'select', id: part.id })}>
          Select it
        </button>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------------------------------- fields, lists, pictures

const NOT_TEXT_INPUT = ['checkbox', 'radio', 'range', 'color', 'file', 'submit', 'button', 'image', 'reset', 'hidden'];

function FieldExtras({ info, val, change, preview }: { info: SelectionInfo; val: (p: string) => string; change: Change; preview: Preview }) {
  const tag = info.tag;
  const type = (/\stype="([^"]+)"/i.exec(info.html)?.[1] ?? (tag === 'input' ? 'text' : '')).toLowerCase();
  const texty = tag === 'textarea' || (tag === 'input' && !NOT_TEXT_INPUT.includes(type));
  const accent = (tag === 'input' && ['checkbox', 'radio', 'range'].includes(type)) || tag === 'progress';
  if (!texty && !accent) return null;
  return (
    <Group title={texty ? 'Field' : 'Control colour'}>
      {texty && <ColorRow label="Placeholder" prop="color" val={() => info.editSlots.placeholder?.color ?? info.computed['placeholder-color']} change={(patch) => change(patch, 'Placeholder colour', { slot: 'placeholder' })} preview={(patch) => preview(patch, 'placeholder')} />}
      {texty && <ColorRow label="Typing cursor" prop="caret-color" val={(p) => (val(p) === 'auto' ? val('color') : val(p))} change={change} preview={preview} />}
      {accent && <ColorRow label="Accent" prop="accent-color" val={(p) => (val(p) === 'auto' ? '' : val(p))} change={change} preview={preview} />}
    </Group>
  );
}

const BULLETS: [string, string][] = [['disc', '• Dot'], ['circle', '◦ Circle'], ['square', '▪ Square'], ['decimal', '1. Numbers'], ['lower-alpha', 'a. Letters'], ['upper-roman', 'I. Roman'], ['none', 'None']];

function ListBullets({ info, val, change, preview }: { info: SelectionInfo; val: (p: string) => string; change: Change; preview: Preview }) {
  const now = info.editCss['list-style-type'] ?? val('list-style-type');
  const symbol = /^["']/.test(now) ? now.slice(1, -1).trim() : '';
  const [sym, setSym] = useState(symbol);
  useEffect(() => setSym(symbol), [symbol]);
  if (!['ul', 'ol', 'li'].includes(info.tag)) return null;
  const setSymbol = (s: string) => {
    const clean = s.replace(/["\\]/g, '').trim().slice(0, 3);
    if (clean) change({ 'list-style-type': `"${clean} "` }, 'Bullet symbol');
  };
  return (
    <Group title="Bullets">
      <Row label="Style">
        <select value={symbol ? 'symbol' : BULLETS.some(([v]) => v === now) ? now : ''} onChange={(e) => (e.target.value === 'symbol' ? setSymbol(sym || '★') : change({ 'list-style-type': e.target.value || null }, 'Bullet style'))}>
          {!BULLETS.some(([v]) => v === now) && !symbol && <option value="">As the site has it</option>}
          {BULLETS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
          <option value="symbol">A symbol of your own…</option>
        </select>
      </Row>
      {symbol && (
        <Row label="Symbol">
          <input type="text" className="ed-num" value={sym} maxLength={3} aria-label="Bullet symbol" onChange={(e) => setSym(e.target.value)} onBlur={() => sym !== symbol && setSymbol(sym)} onKeyDown={(e) => e.key === 'Enter' && setSymbol(sym)} />
        </Row>
      )}
      <ColorRow label="Bullet colour" prop="color" val={() => info.editSlots.marker?.color ?? val('color')} change={(patch) => change(patch, 'Bullet colour', { slot: 'marker' })} preview={(patch) => preview(patch, 'marker')} />
    </Group>
  );
}

const FILTERS: [string, string][] = [['', 'As it is'], ['grayscale(1)', 'Black and white'], ['sepia(0.75)', 'Sepia'], ['saturate(1.7)', 'Vivid'], ['saturate(0.45)', 'Muted'], ['brightness(0.75)', 'Darker'], ['brightness(1.2)', 'Brighter'], ['blur(3px)', 'Soft blur'], ['invert(1)', 'Inverted']];

function ImageLook({ val, change }: { val: (p: string) => string; change: Change }) {
  const now = val('filter');
  return (
    <Group title="Look">
      <Row label="Filter">
        <select value={FILTERS.some(([v]) => v === now) ? now : ''} onChange={(e) => change({ filter: e.target.value || null }, 'Picture look')}>
          {FILTERS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </Row>
    </Group>
  );
}

// ------------------------------------------------------------------------------------------- moving

const MOVE_KEY = 'ww-editor-move';

const readMoveMode = (): MoveMode => {
  try {
    return localStorage.getItem(MOVE_KEY) === 'free' ? 'free' : 'layout';
  } catch {
    return 'layout';
  }
};
const SITS: Record<string, Patch> = {
  '': { display: null, float: null, 'vertical-align': null },
  line: { display: 'block', float: 'none', 'vertical-align': null },
  inline: { display: 'inline-block', float: 'none', 'vertical-align': 'middle' },
  left: { float: 'left', display: null, 'vertical-align': null, 'margin-right': '16px' },
  right: { float: 'right', display: null, 'vertical-align': null, 'margin-left': '16px' },
};
const sitsOf = (css: Record<string, string>) => (css.float === 'left' ? 'left' : css.float === 'right' ? 'right' : css.display === 'block' ? 'line' : css.display === 'inline-block' ? 'inline' : '');

function MoveGroup({ info, val, change, send }: { info: SelectionInfo; val: (p: string) => string; change: Change; send: (m: ToPage) => void }) {
  const m = info.move;
  const layout = m.mode === 'layout' && m.canLayout;
  const setMode = (mode: MoveMode) => {
    try {
      localStorage.setItem(MOVE_KEY, mode);
    } catch {
      /* not remembered */
    }
    send({ t: 'moveMode', mode });
  };
  const sits = sitsOf(info.editCss);
  const offset = !!info.editCss.translate;
  const pickSits = (v: string) => {
    const patch: Patch = { ...SITS[v] };
    // the space a float kept beside it goes when it no longer floats
    if (v !== 'left' && info.editCss['margin-right'] === '16px' && info.editCss.float === 'left') patch['margin-right'] = null;
    if (v !== 'right' && info.editCss['margin-left'] === '16px' && info.editCss.float === 'right') patch['margin-left'] = null;
    change(patch, 'How it sits');
  };
  return (
    <Group title="Move">
      {m.canLayout && (
        <Row label="Dragging">
          <Choice value={layout ? 'layout' : 'free'} options={[['layout', 'In the layout'], ['free', 'Free']]} onPick={(v) => setMode(v as MoveMode)} />
        </Row>
      )}
      <p className="hint">
        {layout
          ? 'Drag the move handle on the page and drop it between other things: a green line shows where it lands. It stays a working part of the page. Alt+arrow keys move it a step.'
          : 'Drag the move handle to shift how it looks; everything around it stays where it is. Arrow keys nudge it.'}
      </p>
      {m.canLayout && (
        <div className="ed-add" role="group" aria-label="Move it in the layout">
          <button className="ghost small-btn" title="Before the element before it (Alt+↑)" onClick={() => send({ t: 'moveStep', dir: 'earlier' })}>
            ↑ Earlier
          </button>
          <button className="ghost small-btn" title="After the element after it (Alt+↓)" onClick={() => send({ t: 'moveStep', dir: 'later' })}>
            ↓ Later
          </button>
          <button className="ghost small-btn" title="Out of the box it is in, just after it (Alt+Shift+←)" onClick={() => send({ t: 'moveStep', dir: 'out' })}>
            Out of its box
          </button>
          <button className="ghost small-btn" title="Into the box just before it, at its end (Alt+Shift+→)" onClick={() => send({ t: 'moveStep', dir: 'in' })}>
            Into the box before
          </button>
        </div>
      )}
      {m.moved && (
        <div className="ed-inline">
          <span className="hint">{m.gaveUp ? 'Moved, but this page keeps putting it back, so here it stays in its old place.' : 'Moved in the layout.'}</span>
          <button className="link-btn" onClick={() => send({ t: 'unmove' })}>
            Put it back
          </button>
        </div>
      )}
      {m.canLayout && (
        <Row label="Sits">
          <select value={sits} onChange={(e) => pickSits(e.target.value)}>
            <option value="">As the site has it</option>
            <option value="line">On its own line</option>
            <option value="inline">In line with its neighbours</option>
            <option value="left">Left, text wraps around it</option>
            <option value="right">Right, text wraps around it</option>
          </select>
        </Row>
      )}
      {m.canLayout && m.parent !== 'flow' && (
        <p className="hint">
          {m.parent === 'grid' ? 'The box it is in places its contents in a grid' : m.parent === 'row' ? 'The box it is in lines its contents up in a row' : 'The box it is in stacks its contents'}, so that decides where it sits; wrapping text around it does not apply here.
        </p>
      )}
      {(!layout || offset) && <TranslateRow val={val} change={change} />}
      <NumRow
        label="Layer"
        prop="z-index"
        val={(p) => (val(p) === 'auto' ? '0' : val(p))}
        change={(patch, l) => change({ ...patch, ...(val('position') === 'static' ? { position: 'relative' } : {}) }, l)}
        min={-10}
        max={9999}
        unitless
      />
    </Group>
  );
}

function Choice({ value, options, onPick }: { value: string; options: [string, string][]; onPick: (v: string) => void }) {
  return (
    <span className="seg-row ed-seg">
      {options.map(([v, l]) => (
        <button key={v || 'none'} type="button" aria-pressed={value === v} className={value === v ? 'seg active' : 'seg'} onClick={(e) => (e.preventDefault(), onPick(v))}>
          {l}
        </button>
      ))}
    </span>
  );
}

/** A plain colour that is partly see-through (a gradient is shown as itself). */
const seeThrough = (c: string) => !c.includes('gradient') && alphaOf(c) < 0.995;
/**
 * A see-through colour as the tree's marker shows it: 10 points stronger than it is, so a faint one (5% black) is
 * still seen on the checkerboard. The Background slider shows the real strength.
 */
function markerColor(c: string): string {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(c.trim());
  if (!m) return c;
  return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${Math.min(1, alphaOf(c) + 0.1).toFixed(3)})`;
}

const CARDS_KEY = 'ww-editor-cards';
/** The cards open until someone closes them. */
const OPEN_FIRST = new Set(['select', 'appearance']);
const readCards = (): Record<string, boolean> => {
  try {
    const v = JSON.parse(localStorage.getItem(CARDS_KEY) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};

/** One card of options: a heading that opens and closes it. */
function Card({ id, title, hint, open, onToggle, children }: { id: string; title: string; hint?: string; open: boolean; onToggle: (id: string) => void; children: React.ReactNode }) {
  return (
    <section className={open ? 'ed-card open' : 'ed-card'}>
      <button className="ed-card-head" aria-expanded={open} aria-controls={`ed-card-${id}`} onClick={() => onToggle(id)}>
        <span className="ed-chev" aria-hidden="true">
          <ChevronIcon size={15} />
        </span>
        <span className="ed-card-title">{title}</span>
        {hint && <span className="ed-card-hint">{hint}</span>}
      </button>
      {open && (
        <div className="ed-card-body" id={`ed-card-${id}`}>
          {children}
        </div>
      )}
    </section>
  );
}

/** Where it is: moving it (also among the ones alike), and hiding or deleting it. */
function PositionPane({ info, val, change, send }: { info: SelectionInfo; val: (p: string) => string; change: Change; send: (m: ToPage) => void }) {
  const hidden = info.editCss.visibility === 'hidden' || info.editCss.display === 'none';
  return (
    <div className="ed-options">
      {!info.multi && info.repeated && <p className="hint">One of {info.repeated} alike here. Earlier and Later move it among the others.</p>}
      {info.caps.move && <MoveGroup info={info} val={val} change={change} send={send} />}
      {info.caps.hide && (
        <Group title="Show or remove">
          <div className="ed-add">
            <button className="ghost small-btn" onClick={() => change(hidden ? { visibility: null, display: null } : info.origin === 'webloom' || info.pseudo ? { display: 'none' } : { visibility: 'hidden' }, hidden ? 'Show' : 'Hide')} title={hidden ? 'Show it again' : 'Make it invisible; its space stays'}>
              {hidden ? 'Show it again' : 'Hide it'}
            </button>
            <button className="ghost small-btn danger-btn" onClick={() => send({ t: 'delete' })} title={info.added ? 'Remove this added element' : 'Take it off the page (no empty space left). You can undo this.'}>
              Delete
            </button>
          </div>
          <p className="hint">Hide keeps its space; Delete takes it away and what is around it closes up.</p>
        </Group>
      )}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="ed-group">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="ed-field">
      <span className="ed-field-label">{label}</span>
      {children}
    </label>
  );
}
function NumRow({ label, prop, val, change, unit = '', min, max, step = 1, unitless }: { label: string; prop: string; val: (p: string) => string; change: Change; unit?: string; min: number; max: number; step?: number; unitless?: boolean }) {
  const cur = px(val(prop));
  const [draft, setDraft] = useState(cur);
  useEffect(() => setDraft(cur), [cur]);
  const commit = () => {
    if (draft === cur) return;
    if (draft === '') return change({ [prop]: null }, label);
    const n = Math.min(max, Math.max(min, Number(draft)));
    if (Number.isFinite(n)) change({ [prop]: unitless ? String(n) : `${n}${unit}` }, label);
  };
  return (
    <Row label={label}>
      <span className="ed-inline">
        <input className="ed-num" type="number" min={min} max={max} step={step} value={draft} placeholder="auto"onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
        {unit && <span className="hint">{unit}</span>}
      </span>
    </Row>
  );
}
function SliderRow({ label, prop, val, change, preview, min, max, toCss, fromCss, suffix }: { label: string; prop: string; val: (p: string) => string; change: Change; preview: Preview; min: number; max: number; toCss: (v: number) => string; fromCss: (s: string) => number; suffix: string }) {
  const cur = fromCss(val(prop));
  const [v, setV] = useState(cur);
  useEffect(() => setV(cur), [cur]);
  return (
    <Row label={label}>
      <span className="ed-inline ed-slider">
        <input
          type="range"
          min={min}
          max={max}
          value={v}
          aria-label={label}
          onChange={(e) => {
            setV(Number(e.target.value));
            preview({ [prop]: toCss(Number(e.target.value)) });
          }}
          onPointerUp={() => change({ [prop]: toCss(v) }, label)}
          onKeyUp={() => change({ [prop]: toCss(v) }, label)}
        />
        <span className="hint ed-val">
          {v}
          {suffix}
        </span>
      </span>
    </Row>
  );
}
/**
 * A colour, or (with `gradient`: where CSS can paint one there) a gradient of two or three colours. Picking a solid
 * colour again takes the gradient away.
 */
function ColorRow({ label, prop, val, change, preview, clear, gradient, note, fit }: { label: string; prop: string; val: (p: string) => string; change: Change; preview: Preview; clear?: boolean; gradient?: GradientUse; note?: string; fit?: Patch }) {
  const hex = toHex(val(prop));
  const none = transparent(val(prop));
  // how strong the colour is (a 60% black over a green button reads as dark green, not black)
  const strength = none ? 1 : alphaOf(val(prop));
  const [a, setA] = useState(strength);
  useEffect(() => setA(strength), [strength]);
  const g = gradient ? currentGradient(gradient, val) : null;
  // a text gradient spans the words, not a box far wider than them (fit: sized to the words)
  const gp = (n: Gradient | null): Patch => ({ ...gradientPatch(gradient!, n), ...(gradient === 'text' ? (n && fit ? fit : NO_FIT) : {}) });
  // a colour picked keeps the strength it had (a fresh colour where there was none is solid)
  const solid = (v: string): Patch => ({ [prop]: strength < 1 ? rgba(v, strength) : v, ...(g && gradient ? gp(null) : {}) });
  const withStrength = (s: number): Patch => ({ [prop]: s >= 0.995 ? hex : rgba(hex, s) });
  return (
    <>
      <Row label={label}>
        <span className="ed-inline">
          {!g && (
            // none: a see-through checkerboard (a colour picker on its own would show white); it still opens the picker
            <span className={none ? 'ed-color-wrap none' : 'ed-color-wrap'} title={none ? `No ${label.toLowerCase()}: pick a colour` : undefined}>
              <ColorInput value={hex} aria-label={none ? `${label}: none. Pick a colour` : label} onPreview={(v) => preview(solid(v))} onCommit={(v) => change(solid(v), label)} />
            </span>
          )}
          <span className="hint ed-val">{g ? 'Gradient' : none ? 'none' : strength < 0.995 ? `${hex} · ${Math.round(strength * 100)}%` : hex}</span>
          {gradient && (
            <GradientToggle on={!!g} label={label} onToggle={() => (g ? change(gp(null), `${label}: solid`) : change(gp(startGradient(transparent(val(prop)) ? '' : hex)), `${label} gradient`))} />
          )}
          {clear && !g && !none && (
            <button className="link-btn" onClick={(e) => (e.preventDefault(), change({ [prop]: 'transparent' }, `No ${label.toLowerCase()}`))}>
              Clear
            </button>
          )}
        </span>
      </Row>
      {/* a background's strength: shown (and changed) so a see-through colour is not mistaken for a solid one */}
      {clear && !g && !none && (
        <Row label="Colour opacity">
          <span className="ed-inline ed-slider">
            <input type="range" min={0} max={100} value={Math.round(a * 100)} aria-label={`${label} opacity`} onChange={(e) => { const s = Number(e.target.value) / 100; setA(s); preview(withStrength(s)); }} onPointerUp={() => change(withStrength(a), `${label} opacity`)} onKeyUp={() => change(withStrength(a), `${label} opacity`)} />
            <span className="hint ed-val">{Math.round(a * 100)}%</span>
          </span>
        </Row>
      )}
      {g && gradient && <GradientEditor g={g} label={label} note={note} onPreview={(n) => preview(gp(n))} onChange={(n, what) => change(gp(n), `${label} gradient ${what}`)} />}
    </>
  );
}

const NO_FIT: Patch = { 'background-size': null, 'background-repeat': null, 'background-position': null };
/** Sizes a text gradient to the words when they are much narrower than the box (where they sit in it: its alignment). */
const textFit = (info: SelectionInfo, val: (p: string) => string): Patch | undefined => {
  if (!info.textWidth) return undefined;
  const a = val('text-align');
  return { 'background-size': `${info.textWidth}px 100%`, 'background-repeat': 'no-repeat', 'background-position': /center/.test(a) ? 'center' : /right|end/.test(a) ? 'right' : 'left' };
};

/** A gradient to start from one colour (or a pleasant default when there is none). */
const startGradient = (hex: string): Gradient => {
  const a = hex && hex !== '#ffffff' ? hex : '#7a5ea8';
  return { kind: 'linear', angle: 135, stops: [a, partnerOf(a)] };
};

function GradientToggle({ on, label, onToggle, disabled }: { on: boolean; label: string; onToggle: () => void; disabled?: boolean }) {
  return (
    <button className={on ? 'ed-grad-toggle on' : 'ed-grad-toggle'} aria-pressed={on} disabled={disabled} title={on ? `Make the ${label.toLowerCase()} one colour again` : `Use a gradient for the ${label.toLowerCase()}`} onClick={(e) => (e.preventDefault(), onToggle())}>
      <span className="ed-grad-swatch" aria-hidden="true" />
      {on ? 'Solid' : 'Gradient'}
    </button>
  );
}

const withStop = (g: Gradient, i: number, c: string): Gradient => ({ ...g, stops: g.stops.map((x, j) => (j === i ? c : x)) });

/** The colours of a gradient (2 or 3) and its direction, with a strip showing it. */
function GradientEditor({ g, label, note, onPreview, onChange }: { g: Gradient; label: string; note?: string; onPreview: (g: Gradient) => void; onChange: (g: Gradient, what: string) => void }) {
  const dir = g.kind === 'radial' ? 'radial' : String(Math.round(g.angle));
  const known = dir === 'radial' || GRADIENT_DIRECTIONS.some(([a]) => String(a) === dir);
  return (
    <div className="ed-grad" role="group" aria-label={`${label} gradient`}>
      <span className="ed-grad-bar" style={{ backgroundImage: gradientCss({ ...g, kind: 'linear', angle: 90 }) }} aria-hidden="true" />
      <div className="ed-grad-row">
        {g.stops.map((c, i) => (
          <ColorInput key={i} aria-label={`${label} gradient colour ${i + 1}`} value={toHex(c)} onPreview={(v) => onPreview(withStop(g, i, v))} onCommit={(v) => onChange(withStop(g, i, v), 'colour')} />
        ))}
        {g.stops.length < 3 ? (
          <button className="ed-grad-btn" title="Add a third colour" onClick={() => onChange({ ...g, stops: [g.stops[0], g.stops[1], g.stops[0]] }, 'colour added')}>
            + Colour
          </button>
        ) : (
          <button className="ed-grad-btn" title="Back to two colours" onClick={() => onChange({ ...g, stops: g.stops.slice(0, 2) }, 'colour removed')}>
            − Colour
          </button>
        )}
        <button className="ed-grad-btn" title="Swap the colours around" aria-label="Reverse the gradient" onClick={() => onChange({ ...g, stops: [...g.stops].reverse() }, 'reversed')}>
          ⇄
        </button>
        <select aria-label={`${label} gradient direction`} value={known ? dir : ''} onChange={(e) => onChange(e.target.value === 'radial' ? { ...g, kind: 'radial' } : { ...g, kind: 'linear', angle: Number(e.target.value) }, 'direction')}>
          {!known && <option value="">{dir}°</option>}
          {GRADIENT_DIRECTIONS.map(([a, n]) => (
            <option key={a} value={String(a)}>
              {n}
            </option>
          ))}
          <option value="radial">From the centre</option>
        </select>
      </div>
      {note && <p className="hint">{note}</p>}
    </div>
  );
}
function BoxRow({ label, prop, val, change }: { label: string; prop: 'padding' | 'margin'; val: (p: string) => string; change: Change }) {
  const sides = ['top', 'right', 'bottom', 'left'];
  return (
    <Row label={label}>
      <span className="ed-inline ed-box4">
        {sides.map((s) => (
          <SideInput key={s} side={s} value={px(val(`${prop}-${s}`))} onCommit={(n) => change({ [`${prop}-${s}`]: `${n}px` }, `${label} ${s}`)} />
        ))}
      </span>
    </Row>
  );
}
function SideInput({ side, value, onCommit }: { side: string; value: string; onCommit: (n: number) => void }) {
  const [d, setD] = useState(value);
  useEffect(() => setD(value), [value]);
  const commit = () => d !== value && d !== '' && Number.isFinite(Number(d)) && onCommit(Number(d));
  return <input className="ed-num small" type="number" title={side} aria-label={side} value={d} onChange={(e) => setD(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />;
}
function TranslateRow({ val, change }: { val: (p: string) => string; change: Change }) {
  const t = val('translate');
  const [x, y] = !t || t === 'none' ? [0, 0] : t.split(/\s+/).map((n) => parseFloat(n) || 0);
  return (
    <Row label="Offset">
      <span className="ed-inline">
        <SideInput side="Left / right (px)" value={String(Math.round(x ?? 0))} onCommit={(n) => change({ translate: `${n}px ${Math.round(y ?? 0)}px` }, 'Move')} />
        <SideInput side="Up / down (px)" value={String(Math.round(y ?? 0))} onCommit={(n) => change({ translate: `${Math.round(x ?? 0)}px ${n}px` }, 'Move')} />
        {t && t !== 'none' && (
          <button className="link-btn" onClick={(e) => (e.preventDefault(), change({ translate: null }, 'Back in place'))}>
            Back in place
          </button>
        )}
      </span>
    </Row>
  );
}
function Seg({ value, options, onPick }: { value: string; options: string[]; onPick: (v: string) => void }) {
  return (
    <span className="seg-row ed-seg">
      {options.map((o) => (
        <button key={o} type="button" className={value === o ? 'seg active' : 'seg'} onClick={(e) => (e.preventDefault(), onPick(o))}>
          {o}
        </button>
      ))}
    </span>
  );
}
function TextField({ value, onCommit }: { value: string; onCommit: (t: string) => void }) {
  const [d, setD] = useState(value);
  useEffect(() => setD(value), [value]);
  return <textarea className="ed-text" rows={2} value={d} onChange={(e) => setD(e.target.value)} onBlur={() => d !== value && onCommit(d)} aria-label="Text" />;
}

/** Shrinks a chosen picture, stores it with the extension (this device only) and returns its token. */
async function storePicture(host: string, file: File): Promise<string | undefined> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * scale));
  c.height = Math.max(1, Math.round(bmp.height * scale));
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  let data = '';
  for (const q of [0.85, 0.7, 0.5, 0.35]) {
    data = c.toDataURL('image/webp', q);
    if (data.length < 650_000) break;
  }
  return (await mutate(host, { action: 'saveArt', dataUrl: data, w: c.width, h: c.height })).token;
}

const ADD_KINDS: [InsertKind, string][] = [
  ['text', 'Text'], ['heading', 'Heading'], ['button', 'Button'], ['image', 'Image…'], ['divider', 'Divider'], ['box', 'Box'],
];

/** Adds a new element before, after or inside the selected one (an image asks for the picture first). */
function AddElement({ host, info, send, setError }: { host: string; info: SelectionInfo; send: (m: ToPage) => void; setError: (s: string) => void }) {
  const page = info.kind === 'page';
  const [position, setPosition] = useState<InsertPosition>(page ? 'inside' : 'after');
  const where: InsertPosition = page ? 'inside' : position;
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [thinking, setThinking] = useState(false);
  const [reply, setReply] = useState('');
  useEffect(() => setReply(''), [info.id]);
  const place = where === 'inside' ? 'inside the selected element, at its end' : `${where} the selected element`;
  /** Add with AI: the model designs one element (kind, words, style) that goes where "Where" says. */
  const addWithAi = async () => {
    const text = prompt.trim();
    if (!text || thinking) return;
    setThinking(true);
    setReply('');
    try {
      const res = await ask<AddElementResponse>({ type: 'ww:editElement', mode: 'add', prompt: `${text}\n(It goes ${place}.)`, el: { ...info, similarCount: info.similar?.count ?? 0 } });
      if (!res?.ok) throw new Error(res?.error ?? 'Claude could not add it.');
      send({ t: 'add', kind: res.add.kind, position: where, css: res.add.css, text: res.add.text });
      setReply(res.reply || 'Added.');
      setPrompt('');
    } catch (e) {
      setReply(e instanceof Error ? e.message : String(e));
    } finally {
      setThinking(false);
    }
  };
  const pick = async (file: File) => {
    setBusy(true);
    try {
      const token = await storePicture(host, file);
      if (token) send({ t: 'add', kind: 'image', position: where, css: { 'background-image': `url("${token}")` } });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That image could not be used.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ed-options">
      {!page && (
        <Row label="Where">
          <select value={position} onChange={(e) => setPosition(e.target.value as InsertPosition)}>
            <option value="after">After this</option>
            <option value="before">Before this</option>
            <option value="inside">Inside this, at the end</option>
          </select>
        </Row>
      )}
      <div className="ed-add">
        {ADD_KINDS.map(([k, label]) => (
          <button key={k} className="ghost small-btn" disabled={busy} onClick={() => (k === 'image' ? input.current?.click() : send({ t: 'add', kind: k, position: where }))}>
            {k === 'image' && busy ? 'Adding…' : label}
          </button>
        ))}
      </div>
      <input ref={input} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void pick(f); }} />
      <div className="ed-ask">
        <h3>
          <SparkleIcon size={15} /> Or describe it
        </h3>
        <textarea rows={2} value={prompt} placeholder="e.g. a small note saying “Sponsored” in the theme’s colours" onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), void addWithAi())} disabled={thinking} aria-label="Describe the element to add" />
        <div className="ed-inline">
          <button className="primary small-btn" onClick={() => void addWithAi()} disabled={thinking || !prompt.trim()}>
            {thinking ? 'Adding…' : 'Add with AI'}
          </button>
          {reply && <span className="hint ed-reply">{reply}</span>}
        </div>
      </div>
    </div>
  );
}

const BG_FITS: [string, string, Record<string, string>][] = [
  ['cover', 'Fill and crop', { 'background-size': 'cover', 'background-repeat': 'no-repeat' }],
  ['contain', 'Show it all', { 'background-size': 'contain', 'background-repeat': 'no-repeat' }],
  ['tile', 'Tile', { 'background-size': 'auto', 'background-repeat': 'repeat' }],
];
const BG_POSITIONS: [string, string][] = [
  ['center', 'Centre'], ['top', 'Top'], ['bottom', 'Bottom'], ['left', 'Left'], ['right', 'Right'],
];

/** A picture of your own as the element's background (stored on this device; the site is not changed). */
function BackgroundImage({ host, info, change, setError }: { host: string; info: SelectionInfo; change: Change; setError: (s: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const mine = /ww-asset-art:/.test(info.editCss['background-image'] ?? '');
  // a picture the site or design draws there (not a gradient: the Background row edits those), and one taken away here
  const removed = info.editCss['background-image'] === 'none';
  const theirs = !mine && !removed && /url\(/.test(info.computed['background-image'] ?? '');
  const fit = info.editCss['background-repeat'] === 'repeat' ? 'tile' : info.editCss['background-size'] === 'contain' ? 'contain' : 'cover';
  const pos = info.editCss['background-position'] ?? 'center';
  const pick = async (file: File) => {
    setBusy(true);
    try {
      const token = await storePicture(host, file);
      if (token) change({ 'background-image': `url("${token}")`, 'background-position': pos, ...(BG_FITS.find(([k]) => k === fit)![2]) }, 'Background image');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That image could not be used.');
    } finally {
      setBusy(false);
    }
  };
  // part of Appearance, right under Background (a plain row: buttons inside a <label> would click by themselves)
  return (
    <>
      <div className="ed-field">
        <span className="ed-field-label">Background image</span>
        <span className="ed-inline">
          <button className="ghost small-btn" onClick={() => input.current?.click()} disabled={busy} title="Stored on this device only. Text on top keeps its own colour, so check it stays readable.">
            {busy ? 'Adding…' : mine ? 'Change…' : 'Add an image…'}
          </button>
          {mine && (
            <button className="link-btn" onClick={() => change({ 'background-image': null, 'background-size': null, 'background-repeat': null, 'background-position': null }, 'Remove background image')}>
              Remove
            </button>
          )}
          {/* the site's (or a design's) own picture or pattern there: it can be taken away, and brought back */}
          {!mine && theirs && (
            <button className="link-btn" onClick={() => change({ 'background-image': 'none' }, 'Remove the background picture')}>
              Remove the picture there
            </button>
          )}
          {!mine && removed && (
            <button className="link-btn" onClick={() => change({ 'background-image': null }, 'Background picture back')}>
              Bring the picture back
            </button>
          )}
        </span>
      </div>
      {!mine && theirs && <p className="hint">It has a picture or pattern behind it now (from the site or the design).</p>}
      {mine && (
        <>
          <Row label="Fit">
            <select value={fit} onChange={(e) => change(BG_FITS.find(([k]) => k === e.target.value)![2], 'Background fit')}>
              {BG_FITS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Position">
            <select value={pos} onChange={(e) => change({ 'background-position': e.target.value }, 'Background position')}>
              {BG_POSITIONS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </Row>
        </>
      )}
      <input ref={input} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void pick(f); }} />
    </>
  );
}

function ReplaceImage({ host, onToken, hasReplacement, onRestore, setError }: { host: string; onToken: (t: string) => void; hasReplacement: boolean; onRestore: () => void; setError: (s: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const pick = async (file: File) => {
    try {
      const token = await storePicture(host, file);
      if (token) onToken(token);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That image could not be used.');
    }
  };
  return (
    <Group title="Image">
      <span className="ed-inline">
        <button className="ghost small-btn" onClick={() => input.current?.click()}>
          Replace image…
        </button>
        {hasReplacement && (
          <button className="link-btn" onClick={onRestore}>
            Use the original
          </button>
        )}
      </span>
      <input ref={input} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && void pick(e.target.files[0])} />
      <p className="hint">Shown instead of the site’s picture, on this device only. The site itself is not changed.</p>
    </Group>
  );
}

// ------------------------------------------------------------------------------------------- Code

const SLOT_NAMES: Record<Slot, string> = { hover: 'While pointed at', focus: 'While focused', shapes: 'Its icon shapes', placeholder: 'Placeholder text', marker: 'Bullets' };

function CodePane({ info, change, preview }: { info: SelectionInfo; change: Change; preview: Preview }) {
  const text = Object.entries(info.editCss)
    .map(([k, v]) => `${k}: ${v};`)
    .join('\n');
  const [draft, setDraft] = useState(text);
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => {
    setDraft(text);
    setErrors([]);
  }, [text, info.id]);
  const check = (src: string) => {
    const { css, errors: errs } = parseDeclarations(src);
    for (const [p, v] of Object.entries(css)) if (!p.startsWith('--') && !CSS.supports(p, v)) errs.push(`“${p}: ${v}” is not something the browser understands.`);
    return { css, errs };
  };
  const toPatch = (css: Record<string, string>) => {
    const patch: Record<string, string | null> = {};
    for (const k of Object.keys(info.editCss)) if (!(k in css)) patch[k] = null;
    return Object.assign(patch, css);
  };
  const onEdit = (src: string) => {
    setDraft(src);
    const { css, errs } = check(src);
    setErrors(errs);
    if (!errs.length) preview(toPatch(css));
  };
  const applyCode = () => {
    const { css, errs } = check(draft);
    setErrors(errs);
    if (!errs.length) change(toPatch(css), 'CSS edit');
  };
  return (
    <div className="ed-code">
      <h3>Your CSS for this element</h3>
      <p className="hint">Only declarations, like “color: #fff;”. They are applied on top of the theme and preview as you type.</p>
      <textarea className="ed-css" spellCheck={false} rows={Math.min(14, Math.max(4, draft.split('\n').length + 1))} value={draft} onChange={(e) => onEdit(e.target.value)} onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && applyCode()} aria-label="CSS declarations" />
      {errors.length > 0 && (
        <ul className="ed-errors" role="alert">
          {errors.map((er, i) => (
            <li key={i}>{er}</li>
          ))}
        </ul>
      )}
      <div className="ed-inline">
        <button className="primary small-btn" onClick={applyCode} disabled={errors.length > 0 || draft === text}>
          Apply
        </button>
        {draft !== text && (
          <button className="ghost small-btn" onClick={() => onEdit(text)}>
            Discard
          </button>
        )}
      </div>
      {SLOTS.some((k) => info.editSlots[k]) && (
        <>
          <h3>Its other looks (change them in Options)</h3>
          <pre className="ed-pre">
            {SLOTS.filter((k) => info.editSlots[k])
              .map((k) => `/* ${SLOT_NAMES[k]} */\n${Object.entries(info.editSlots[k]!).map(([p, v]) => `${p}: ${v};`).join('\n')}`)
              .join('\n\n')}
          </pre>
        </>
      )}
      <h3>From the theme (written by Claude, read-only)</h3>
      {info.themeRules.length ? <pre className="ed-pre">{info.themeRules.join('\n\n')}</pre> : <p className="hint">The theme has no rules for this element.</p>}
      <h3>HTML (read-only)</h3>
      <pre className="ed-pre">{info.html}</pre>
      <p className="hint">Edits never change the website’s own code: they are drawn over it in your browser.</p>
      <details className="ed-details">
        <summary>Current styles</summary>
        <pre className="ed-pre">{Object.entries(info.computed).filter(([, v]) => v && v !== 'none' && v !== 'normal' && v !== 'auto').map(([k, v]) => `${k}: ${v};`).join('\n')}</pre>
      </details>
    </div>
  );
}

// ------------------------------------------------------------------------------------------- AI

type AiContext = { text: string; refs: Record<string, EditBase> };

/**
 * Modify with Claude. Claude sees the selection and may ask to see more first (what it sits in, what is inside it,
 * what is next to it, the others like it, the page); it is then shown that and answers. Its answer can change the
 * selection and, when the request calls for it, the others like it, the page, or elements it was shown.
 */
function AskClaude({ info, askContext, onResult }: { info: SelectionInfo; askContext: (want: AiContextKind[]) => Promise<AiContext>; onResult: (changes: AiChange[], refs: Record<string, EditBase>, label: string) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState('');
  const [reply, setReply] = useState('');
  useEffect(() => setReply(''), [info.id]);
  const go = async () => {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setBusy('Modifying…');
    setReply('');
    try {
      const el = { ...info, similarCount: info.similar?.count ?? 0, parents: (info.crumbs ?? []).slice(-3).reverse().map((c) => c.label) };
      // what it can change besides the selection: the others like it, the page
      const usable = (refs: Record<string, EditBase>) => Object.keys(refs);
      let ctx = await askContext([]);
      let res = await ask<EditElementResponse>({ type: 'ww:editElement', prompt, el, targets: usable(ctx.refs) });
      if (res?.ok && res.need.length) {
        setBusy('Looking around…');
        const more = await askContext(res.need);
        ctx = { text: more.text, refs: { ...ctx.refs, ...more.refs } };
        setBusy('Modifying…');
        res = await ask<EditElementResponse>({ type: 'ww:editElement', prompt, el, context: ctx.text, targets: usable(ctx.refs), final: true });
      }
      if (!res?.ok) throw new Error(res?.error ?? 'Claude could not change it.');
      if (res.changes.length) onResult(res.changes, ctx.refs, `Claude: ${prompt.slice(0, 40)}`);
      setReply(res.reply || (res.changes.length ? 'Done.' : 'Nothing was changed.'));
      setText('');
    } catch (e) {
      setReply(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };
  return (
    <section className="ed-ask">
      <textarea rows={2} value={text} placeholder={info.similar ? 'Describe the change, e.g. make it look like parchment, make the others match, or make the header around it match' : 'Describe the change, e.g. make it look like parchment, or make the card around it match'} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), void go())} disabled={!!busy} aria-label="How Claude should change the selection" />
      <div className="ed-inline">
        <button className="primary small-btn" onClick={() => void go()} disabled={!!busy || !text.trim()}>
          {busy || 'Modify'}
        </button>
        {reply && <span className="hint ed-reply">{reply}</span>}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------------------------------- helpers

function transparent(css: string): boolean {
  return !css || css === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(css);
}
function toHex(css: string): string {
  if (transparent(css)) return '#ffffff';
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(css ?? '');
  if (!m) return /^#[0-9a-f]{6}$/i.test(css) ? css : '#ffffff';
  return '#' + [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('');
}
function matchFont(v: string): string {
  const f = GOOGLE_FONTS.find((g) => v.includes(g));
  if (f) return `'${f}', serif`;
  if (/^Georgia/i.test(v)) return 'Georgia, serif';
  if (/^system-ui/i.test(v)) return 'system-ui, sans-serif';
  if (/^ui-monospace/i.test(v)) return 'ui-monospace, monospace';
  return '';
}

export type { Design };
