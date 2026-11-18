// Review fixes: the tab-switch guard and serialized settings writes.
const mem: Record<string, any> = {};
const listeners: Array<() => void> = [];
(globalThis as any).chrome = {
  runtime: { id: 'me' },
  storage: {
    local: {
      get: async (k: any) => (k === null ? { ...mem } : { [k]: mem[k] }),
      set: async (o: any) => {
        await new Promise((r) => setTimeout(r, Math.random() * 5)); // writes finish in unpredictable order
        Object.assign(mem, JSON.parse(JSON.stringify(o)));
      },
    },
  },
  tabs: { onActivated: { addListener: (f: () => void) => listeners.push(f), removeListener: (f: () => void) => void listeners.splice(listeners.indexOf(f), 1) } },
};
import { watchActivation } from '../src/shared/tabguard';
import { getSettings, saveModelSettings, savePreviewsSetting, saveTheme } from '../src/shared/storage';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${!cond && extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`);
};

(async () => {
  const w = watchActivation();
  ok('nothing changed yet', !w.changed() && listeners.length === 1);
  listeners.forEach((f) => f());
  ok('a tab switch during the capture is noticed', w.changed());
  w.stop();
  ok('stopping removes the listener', listeners.length === 0);
  ok('works (and does nothing) without the tabs API', (() => { const c = (globalThis as any).chrome; (globalThis as any).chrome = {}; const x = watchActivation(); x.stop(); (globalThis as any).chrome = c; return !x.changed(); })());

  // Quick, overlapping changes must not restore each other's older values.
  await Promise.all([saveTheme('dark'), savePreviewsSetting(false), saveModelSettings({ apiKey: 'k1', openaiKey: 'k2', model: 'claude-sonnet-5-5' }), saveTheme('afterhours')]);
  const s = await getSettings();
  ok('all four overlapping settings writes survive', s.theme === 'afterhours' && s.previews === false && s.apiKey === 'k1' && s.openaiKey === 'k2' && s.model === 'claude-sonnet-5-5', s);
  await saveTheme('light');
  const s2 = await getSettings();
  ok('changing the theme leaves keys and the previews switch alone', s2.theme === 'light' && s2.apiKey === 'k1' && s2.previews === false, s2);

  console.log(fails ? `${fails} FAILED` : 'ALL OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL crashed', e?.stack ?? e); process.exit(1); });
