import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GOOGLE_FONTS, parseDeclarations, upsertEdit, validateEdits, type VisualEdit } from '../shared/edits';
import type { FromPage, SelectionInfo, ToPage, TreeNode } from '../shared/editorProtocol';
import { GLOBAL_HOST, appliesOn, layerOf, scopeOf } from '../shared/scope';
import { getDesignsForHost } from '../shared/storage';
import type { Design, EditElementResponse, MutateMessage } from '../shared/types';
import { ChevronIcon, KindIcon, RedoIcon, SparkleIcon, UndoIcon } from './Icons';

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
async function mutate(host: string, m: Record<string, unknown>): Promise<{ designId?: string; token?: string; version?: number; conflict?: unknown }> {
  const res = await ask<{ ok: boolean; error?: string; designId?: string; token?: string; version?: number; conflict?: unknown }>({ type: 'ww:mutate', host, ...m } as MutateMessage);
  if (!res?.ok) throw new Error(res?.error ?? 'Could not save the change.');
  return res;
}

/** Which design the edits belong to: the page's or the site's own design here; otherwise a new "My edits" one. */
async function pickTarget(host: string, path: string): Promise<{ target: Target; edits: VisualEdit[] }> {
  const [site, global] = await Promise.all([getDesignsForHost(host), getDesignsForHost(GLOBAL_HOST)]);
  const here = [...site, ...global].filter((d) => d.enabled && appliesOn(d, host, path)).sort((a, b) => layerOf(b) - layerOf(a));
  const own = here.find((d) => scopeOf(d) !== 'global');
  if (own) return { target: { designId: own.id, bucket: own.host, name: own.name, version: own.editsUpdatedAt ?? 0 }, edits: validateEdits(own.edits) };
  return { target: { designId: null, bucket: host, name: 'My edits (new)', create: { scope: 'site', path } }, edits: [] };
}

const px = (v: string | undefined) => (v === undefined || v === '' ? '' : String(Math.round(parseFloat(v) * 10) / 10));
const SHADOWS: [string, string][] = [
  ['none', 'None'],
  ['0 1px 3px rgba(0,0,0,.18)', 'Subtle'],
  ['0 6px 18px rgba(0,0,0,.18)', 'Soft'],
  ['0 14px 40px rgba(0,0,0,.28)', 'Deep'],
  ['0 0 18px rgba(212,175,55,.65)', 'Golden glow'],
];

export function Editor({ tabId, host, path, onExit, flash }: { tabId: number; host: string; path: string; onExit: (why?: string) => void; flash: (t: string) => void }) {
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const [target, setTarget] = useState<Target | null>(null);
  const targetRef = useRef<Target | null>(null);
  const [edits, setEdits] = useState<VisualEdit[]>([]);
  const editsRef = useRef<VisualEdit[]>([]);
  const [past, setPast] = useState<Entry[]>([]);
  const [future, setFuture] = useState<Entry[]>([]);
  const [tree, setTree] = useState<Record<string, { nodes: TreeNode[]; more: number }>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['root']));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [info, setInfo] = useState<SelectionInfo | null>(null);
  const [mode, setMode] = useState<'options' | 'code'>('options');
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
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
          // edited in another tab meanwhile: show what is saved (never overwrite it); this editor's history starts over
          const saved = validateEdits(res.conflict);
          editsRef.current = saved;
          setEdits(saved);
          setPast([]);
          setFuture([]);
          targetRef.current = { ...t, version: res.version };
          setTarget(targetRef.current);
          send({ t: 'setEdits', edits: saved });
          setError('These edits were changed in another tab, so that version was kept and is shown now. Your last change here was not saved.');
          setSaving('error');
          return;
        }
        const next = { ...t, ...(res.designId ? { designId: res.designId } : {}), ...(t.designId ? {} : { name: 'My edits', create: undefined }), version: res.version ?? t.version };
        targetRef.current = next;
        setTarget(next);
        if (!t.designId && res.designId) send({ t: 'retarget', designId: res.designId });
        setSaving('saved');
      } catch (e) {
        setSaving('error');
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
      const before = editsRef.current;
      editsRef.current = next;
      setEdits(next);
      setFuture([]);
      setPast((p) => {
        const last = p[p.length - 1];
        // a run of nudges is one step
        if (last && last.label === label && label === 'Nudge' && Date.now() - last.at < 1200) return [...p.slice(0, -1), { ...last, after: next, at: Date.now() }];
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
  const fetchChildren = useCallback((id: string) => send({ t: 'children', id }), [send]);
  const expandPath = useCallback(
    (ids: string[]) => {
      setExpanded((cur) => {
        const next = new Set(cur);
        for (const id of ['root', ...ids.slice(0, -1)]) {
          if (!next.has(id)) next.add(id);
          fetchChildren(id);
        }
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
      const picked = await pickTarget(host, path);
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
            fetchChildren('root');
            return;
          case 'children':
            setTree((t) => ({ ...t, [m.id]: { nodes: m.nodes, more: m.more } }));
            if (m.id === 'root' && m.nodes[0]) expandPath([m.nodes[0].id, '_']);
            return;
          case 'selected':
            setInfo(m.info);
            setSelectedId(m.info.id);
            expandPath(m.path);
            return;
          case 'info':
            setInfo(m.info);
            return;
          case 'cleared':
            setInfo(null);
            setSelectedId(null);
            return;
          case 'gone':
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
            optionsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
        }
      });
      port.postMessage({ t: 'start', designId: picked.target.designId ?? 'new', edits: picked.edits } satisfies ToPage);
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

  // the selected row stays in view
  useEffect(() => {
    if (!selectedId) return;
    const t = window.setTimeout(() => treeRef.current?.querySelector(`[data-node="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: 'nearest' }), 120);
    return () => window.clearTimeout(t);
  }, [selectedId, tree]);

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
  const base = useMemo(() => (info ? { editId: info.editId, target: info.target, label: info.label, origin: info.origin } : null), [info]);
  const change = (patch: Record<string, string | null>, label: string, opts: { text?: string | null; all?: string | null } = {}) => {
    if (!base) return;
    apply(upsertEdit(editsRef.current, base, patch, opts).edits, label);
  };
  const preview = (patch: Record<string, string | null>) => {
    if (!base) return;
    send({ t: 'preview', edits: upsertEdit(editsRef.current, base, patch).edits });
  };
  const val = (prop: string) => info?.editCss[prop] ?? info?.computed[prop] ?? '';
  const resetElement = () => {
    if (info?.editId) apply(editsRef.current.filter((e) => e.id !== info.editId), 'Reset element');
  };
  const resetAll = () => {
    if (!editsRef.current.length) return;
    if (!window.confirm(`Remove all ${editsRef.current.length} manual edit${editsRef.current.length === 1 ? '' : 's'} on this design? The design itself stays. You can undo this.`)) return;
    apply([], 'Reset all edits');
  };

  const done = () => {
    closing.current = true;
    onExit();
  };

  return (
    <div className="editor">
      <div className="ed-head">
        <div className="ed-title">
          <strong>Editing {host.replace(/^www\./, '')}</strong>
          <span className="hint">
            Saved to “{target?.name ?? '…'}” · {saving === 'saving' ? 'saving…' : saving === 'error' ? 'not saved' : edits.length ? `${edits.length} edit${edits.length === 1 ? '' : 's'}` : 'no edits yet'}
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
          <button className="primary small-btn" onClick={done}>
            Done
          </button>
        </div>
      </div>
      {error && (
        <p className="ed-error" role="alert">
          {error}
        </p>
      )}
      <p className="hint ed-tip">{ready ? 'Click anything on the page to select it. Esc clears the selection; arrow keys nudge it.' : 'Connecting to the page…'}</p>

      <div className="ed-tree" ref={treeRef} role="tree" aria-label="Page elements">
        <TreeLevel id="root" depth={0} tree={tree} expanded={expanded} selectedId={selectedId} onToggle={toggle} onSelect={(id) => send({ t: 'select', id })} />
      </div>

      {info ? (
        <div className="ed-panel" ref={optionsRef}>
          <div className="ed-sel">
            <span className={info.origin === 'webloom' ? 'ed-badge ww' : 'ed-badge site'} title={info.origin === 'webloom' ? 'Created by Whimsy Web' : 'Part of the website (restyled or not)'}>
              {info.origin === 'webloom' ? <SparkleIcon size={13} /> : <KindIcon kind={info.kind} size={13} />}
              {info.origin === 'webloom' ? 'Whimsy Web' : 'Website'}
            </span>
            <strong className="ed-sel-name">{info.label}</strong>
            <span className="hint">
              {info.box.w}×{info.box.h}
            </span>
          </div>
          <div className="seg-row ed-mode" role="tablist" aria-label="Editing mode">
            <button role="tab" aria-selected={mode === 'options'} className={mode === 'options' ? 'seg active' : 'seg'} onClick={() => setMode('options')}>
              Options
            </button>
            <button role="tab" aria-selected={mode === 'code'} className={mode === 'code' ? 'seg active' : 'seg'} onClick={() => setMode('code')}>
              Code
            </button>
          </div>
          {mode === 'options' ? (
            <OptionsPane info={info} val={val} change={change} preview={preview} resetElement={resetElement} host={host} setError={setError} />
          ) : (
            <CodePane info={info} change={change} preview={preview} />
          )}
          <AskClaude info={info} onResult={(css, all, label) => {
            if (!base) return;
            const patch: Record<string, string | null> = {};
            for (const k of Object.keys(info.editCss)) if (!(k in css)) patch[k] = null;
            Object.assign(patch, css);
            apply(upsertEdit(editsRef.current, base, patch, { all: all && info.similar ? info.similar.selector : undefined }).edits, label);
          }} />
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

function TreeLevel({ id, depth, tree, expanded, selectedId, onToggle, onSelect }: { id: string; depth: number; tree: Record<string, { nodes: TreeNode[]; more: number }>; expanded: Set<string>; selectedId: string | null; onToggle: (id: string) => void; onSelect: (id: string) => void }) {
  const level = tree[id];
  if (!level) return depth ? <div className="ed-row muted" style={{ paddingLeft: 10 + depth * 14 }}>Loading…</div> : null;
  return (
    <>
      {level.nodes.map((n) => {
        const open = expanded.has(n.id);
        return (
          <div key={n.id} role="none">
            <div
              role="treeitem"
              aria-selected={selectedId === n.id}
              aria-expanded={n.hasChildren ? open : undefined}
              data-node={n.id}
              className={['ed-row', selectedId === n.id ? 'selected' : '', n.hidden ? 'dim' : '', n.origin === 'webloom' ? 'ww' : ''].filter(Boolean).join(' ')}
              style={{ paddingLeft: 6 + depth * 14 }}
              tabIndex={selectedId === n.id ? 0 : -1}
              onClick={() => onSelect(n.id)}
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
              {n.edited && <span className="ed-dot" title="Edited by you" />}
            </div>
            {open && n.hasChildren && <TreeLevel id={n.id} depth={depth + 1} tree={tree} expanded={expanded} selectedId={selectedId} onToggle={onToggle} onSelect={onSelect} />}
          </div>
        );
      })}
      {level.more > 0 && (
        <div className="ed-row muted" style={{ paddingLeft: 26 + depth * 14 }}>
          +{level.more} more (click them on the page to reach them)
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------------------------------- Options

type Change = (patch: Record<string, string | null>, label: string, opts?: { text?: string | null; all?: string | null }) => void;
type Preview = (patch: Record<string, string | null>) => void;

function OptionsPane({ info, val, change, preview, resetElement, host, setError }: { info: SelectionInfo; val: (p: string) => string; change: Change; preview: Preview; resetElement: () => void; host: string; setError: (s: string) => void }) {
  const k = info.kind;
  const textish = k === 'text' || k === 'heading' || k === 'link' || k === 'button';
  const container = k === 'box' || k === 'section' || k === 'list' || k === 'page' || k === 'field' || k === 'video';
  const deco = k === 'decoration' || !!info.pseudo;
  const hidden = info.editCss.visibility === 'hidden' || info.editCss.display === 'none';
  return (
    <div className="ed-options">
      {info.caps.text && (
        <Group title="Text">
          <TextField value={info.editText ?? info.text ?? ''} onCommit={(t) => change({}, 'Edit text', { text: t === (info.text ?? '') && info.editText === undefined ? undefined : t })} />
          {info.editText !== undefined && (
            <button className="link-btn" onClick={() => change({}, 'Original text', { text: null })}>
              Use the site’s original text
            </button>
          )}
        </Group>
      )}
      {(textish || k === 'field') && !deco && (
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
          <ColorRow label="Colour" prop="color" val={val} change={change} preview={preview} />
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
      )}
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
      {container && !deco && (
        <Group title="Spacing">
          <BoxRow label="Padding" prop="padding" val={val} change={change} />
          <BoxRow label="Margin" prop="margin" val={val} change={change} />
        </Group>
      )}
      <Group title="Appearance">
        <ColorRow label="Background" prop="background-color" val={val} change={change} preview={preview} clear />
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
            <input type="color" className="ed-color" aria-label="Border colour" value={toHex(val('border-top-color'))} onChange={(e) => change({ 'border-color': e.target.value }, 'Border colour')} />
          </span>
        </Row>
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
      {info.caps.move && (
        <Group title={info.origin === 'webloom' ? 'Position' : 'Nudge (moves how it looks, not the layout)'}>
          <TranslateRow val={val} change={change} />
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
      )}
      <div className="ed-footer">
        {info.similar && (
          <label className="art-check" title={info.similar.selector}>
            <input type="checkbox" checked={!!info.editAll} disabled={!info.editId} onChange={(e) => change({}, e.target.checked ? 'Apply to similar' : 'Only this one', { all: e.target.checked ? info.similar!.selector : null })} />
            <span>Apply to all {info.similar.count} like this</span>
          </label>
        )}
        {info.caps.hide && (
          <button className="ghost small-btn" onClick={() => change(hidden ? { visibility: null, display: null } : info.origin === 'webloom' || info.pseudo ? { display: 'none' } : { visibility: 'hidden' }, hidden ? 'Show' : 'Hide')}>
            {hidden ? 'Show it again' : 'Hide it'}
          </button>
        )}
        <button className="ghost small-btn" onClick={resetElement} disabled={!info.editId}>
          Reset this element
        </button>
      </div>
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
function ColorRow({ label, prop, val, change, preview, clear }: { label: string; prop: string; val: (p: string) => string; change: Change; preview: Preview; clear?: boolean }) {
  const hex = toHex(val(prop));
  return (
    <Row label={label}>
      <span className="ed-inline">
        <input type="color" className="ed-color" value={hex} aria-label={label} onInput={(e) => preview({ [prop]: (e.target as HTMLInputElement).value })} onChange={(e) => change({ [prop]: e.target.value }, label)} />
        <span className="hint ed-val">{transparent(val(prop)) ? 'none' : hex}</span>
        {clear && (
          <button className="link-btn" onClick={(e) => (e.preventDefault(), change({ [prop]: 'transparent' }, `No ${label.toLowerCase()}`))}>
            Clear
          </button>
        )}
      </span>
    </Row>
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

function ReplaceImage({ host, onToken, hasReplacement, onRestore, setError }: { host: string; onToken: (t: string) => void; hasReplacement: boolean; onRestore: () => void; setError: (s: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const pick = async (file: File) => {
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * scale));
      c.height = Math.max(1, Math.round(bmp.height * scale));
      c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
      let data = '';
      for (const q of [0.85, 0.7, 0.5]) {
        data = c.toDataURL('image/webp', q);
        if (data.length < 650_000) break;
      }
      const res = await mutate(host, { action: 'saveArt', dataUrl: data, w: c.width, h: c.height });
      if (res.token) onToken(res.token);
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

function AskClaude({ info, onResult }: { info: SelectionInfo; onResult: (css: Record<string, string>, all: boolean, label: string) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState('');
  useEffect(() => setReply(''), [info.id]);
  const go = async () => {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setBusy(true);
    setReply('');
    try {
      const res = await ask<EditElementResponse>({ type: 'ww:editElement', prompt, el: { ...info, similarCount: info.similar?.count ?? 0 } });
      if (!res?.ok) throw new Error(res?.error ?? 'Claude could not change it.');
      onResult(res.css, res.all, `Claude: ${prompt.slice(0, 40)}`);
      setReply(res.reply || 'Done.');
      setText('');
    } catch (e) {
      setReply(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="ed-ask">
      <h3>
        <SparkleIcon size={15} /> Ask Claude about this element
      </h3>
      <textarea rows={2} value={text} placeholder={info.similar ? 'e.g. make this look like parchment, or make the others match this one' : 'e.g. make this look like parchment'} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), void go())} disabled={busy} aria-label="What to change" />
      <div className="ed-inline">
        <button className="primary small-btn" onClick={() => void go()} disabled={busy || !text.trim()}>
          {busy ? 'Working…' : 'Change it'}
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
