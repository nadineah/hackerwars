import { useEffect, useRef, useState } from 'react';
import type { ChatTurn } from '../dashboard/background';
import type { DashData, DashState, Dashboard } from '../dashboard/schema';
import { K } from '../dashboard/store';

/** The dashboard page READS storage directly and WRITES only through the background worker. */
export interface Snapshot {
  ready: boolean;
  dashboards: Dashboard[];
  states: Map<string, DashState>;
  data: Map<string, DashData>;
  kv: Map<string, Record<string, unknown>>;
  chats: Map<string, ChatTurn[]>;
  globalPaused: boolean;
  /** Whether an API key is set, so the assistant can say what is missing. */
  hasKey: boolean;
}

const EMPTY: Snapshot = { ready: false, dashboards: [], states: new Map(), data: new Map(), kv: new Map(), chats: new Map(), globalPaused: false, hasKey: false };

export function snapshotFrom(all: Record<string, any>): Snapshot {
  const pick = <T,>(prefix: string) => Object.entries(all).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v as T] as const);
  const s = all.settings ?? {};
  return {
    ready: true,
    dashboards: pick<Dashboard>('dash:').map(([, v]) => v).filter((d) => d.schemaVersion === 2).sort((a, b) => b.updatedAt - a.updatedAt),
    states: new Map(pick<DashState>('dstate:')),
    data: new Map(pick<DashData>('ddata:')),
    kv: new Map(pick<Record<string, unknown>>('dkv:')),
    chats: new Map(pick<ChatTurn[]>('dchat:')),
    globalPaused: !!all[K.settings]?.paused,
    hasKey: !!(s.apiKey || s.openaiKey),
  };
}

const RELEVANT = /^(dash:|dstate:|ddata:|dkv:|dchat:|dset$|settings$)/;

export function useSnapshot(): Snapshot {
  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  useEffect(() => {
    let alive = true;
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      await new Promise((r) => setTimeout(r, 60)); // coalesce bursts of writes
      pending = false;
      const all = await chrome.storage.local.get(null);
      if (alive) setSnap(snapshotFrom(all));
    };
    void load();
    const onChange = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && Object.keys(changes).some((k) => RELEVANT.test(k))) void load();
    };
    chrome.storage.onChanged.addListener(onChange);
    // Relative times ("5 minutes ago") are recomputed every 30 s without touching storage.
    const t = setInterval(() => alive && setSnap((s) => ({ ...s })), 30_000);
    return () => {
      alive = false;
      clearInterval(t);
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, []);
  return snap;
}

export async function call<T = any>(op: string, args: Record<string, unknown> = {}): Promise<T & { ok?: boolean }> {
  const res = await chrome.runtime.sendMessage({ type: 'ww:dash', op, ...args });
  if (!res) throw new Error('The extension did not respond. Reload this page.');
  if (res.ok === false) throw new Error(res.error ?? 'Something went wrong.');
  return res;
}

/** Bounded undo/redo for dashboard code and settings. */
export function useHistory<T>(limit = 50) {
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const [, bump] = useState(0);
  return {
    push(prev: T) {
      past.current = [...past.current.slice(-(limit - 1)), prev];
      future.current = [];
      bump((n) => n + 1);
    },
    undo(current: T): T | undefined {
      const p = past.current.pop();
      if (p === undefined) return undefined;
      future.current.push(current);
      bump((n) => n + 1);
      return p;
    },
    redo(current: T): T | undefined {
      const f = future.current.pop();
      if (f === undefined) return undefined;
      past.current.push(current);
      bump((n) => n + 1);
      return f;
    },
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
  };
}
