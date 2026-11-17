import './confirm.css';
import type { ConfirmSummary } from './external';

/**
 * The install confirmation. It is an extension-owned page, so a website cannot fake or auto-click it. Everything shown
 * comes from the (already re-validated) theme and is set with textContent, never as HTML.
 */
const app = document.getElementById('app')!;
const requestId = new URLSearchParams(location.search).get('r') ?? '';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};

function done(text: string, ok: boolean) {
  app.replaceChildren(el('h1', ok ? 'Done' : 'Nothing changed'), el('p', text, ok ? undefined : 'error'));
  const b = el('button', 'Close', 'primary');
  b.onclick = () => window.close();
  app.append(b);
  b.focus();
}

async function main() {
  const s = (await chrome.runtime.sendMessage({ type: 'ww:community:get', requestId })) as ConfirmSummary | null;
  if (!s) return done('This request is no longer waiting for an answer.', false);

  const h = el('h1', s.update ? 'Update this theme?' : s.reenable ? 'Turn this theme back on?' : 'Apply this theme?');
  const site = el('p', `This will change how ${s.siteName} (${s.hostname}) looks in this browser.`, 'site');
  const dl = el('dl');
  const row = (k: string, v: string) => dl.append(el('dt', k), el('dd', v));
  row('Theme', `${s.title} · v${s.version}`);
  row('Creator', s.creator);
  row('Website', s.hostname);
  row('Pages', s.scope);
  row('License', s.license);
  row('Size', `${(s.cssBytes / 1000).toFixed(1)} KB of CSS`);
  row('From', s.origin);
  if (s.update) row('Replaces', `Your installed version ${s.update.from}`);
  const note = el('p', 'Themes are style sheets only. They cannot run scripts, read the page, or leave this site. Any design you currently use on this website is switched off and comes back if you remove the theme. You can turn it off any time from the Whimsy Web panel.', 'note');
  const err = el('p', '', 'error');
  const buttons = el('div', undefined, 'row');
  const yes = el('button', s.update ? 'Update theme' : 'Apply theme', 'primary');
  const no = el('button', 'Cancel');
  buttons.append(yes, no);
  app.replaceChildren(h, site, dl, note, err, buttons);
  no.focus();

  const answer = async (approve: boolean) => {
    yes.disabled = no.disabled = true;
    const r = (await chrome.runtime.sendMessage({ type: 'ww:community:decide', requestId, approve })) as { ok: boolean; message?: string } | null;
    if (approve && r?.ok) done(r.message ?? 'The theme is installed.', true);
    else if (!approve) window.close();
    else {
      err.textContent = r?.message ?? 'Something went wrong.';
      yes.disabled = no.disabled = false;
    }
  };
  yes.onclick = () => void answer(true);
  no.onclick = () => void answer(false);
}
void main();
