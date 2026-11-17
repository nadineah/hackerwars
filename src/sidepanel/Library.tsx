import { useMemo, useState, type ReactNode } from 'react';
import { GLOBAL_HOST, scopeLabel, scopeOf } from '../shared/scope';
import type { Conversation, Design } from '../shared/types';
import { ArrowRightIcon, GlobeIcon, SearchIcon, TrashIcon } from './Icons';
import { RowMenu, type MenuItem } from './Menu';
import { CheckIcon } from './Icons';

// ------------------------------------------------------------------------------------------ small helpers

/** Case-insensitive, number-aware text order ("Theme 2" before "Theme 10"). */
export const byText = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }) || (a < b ? -1 : a > b ? 1 : 0);
export const byName = (a: Design, b: Design): number => byText(a.name, b.name) || (a.id < b.id ? -1 : 1);

const KNOWN: Record<string, string> = {
  youtube: 'YouTube', github: 'GitHub', wikipedia: 'Wikipedia', reddit: 'Reddit', pinterest: 'Pinterest', google: 'Google', twitter: 'Twitter', x: 'X',
  ycombinator: 'Hacker News', linkedin: 'LinkedIn', stackoverflow: 'Stack Overflow', netflix: 'Netflix', amazon: 'Amazon', facebook: 'Facebook', instagram: 'Instagram',
  wikimedia: 'Wikimedia', nytimes: 'The New York Times', bbc: 'BBC', medium: 'Medium', twitch: 'Twitch', spotify: 'Spotify',
};
/** A friendly site name for a hostname: "www.youtube.com" -> "YouTube", "en.wikipedia.org" -> "Wikipedia". */
export function siteName(host: string): string {
  if (host === GLOBAL_HOST) return 'All sites';
  const labels = host.replace(/^www\./, '').split('.');
  if (labels.length < 2) return host;
  let i = labels.length - 2;
  if (labels.length >= 3 && labels[labels.length - 1].length === 2 && ['co', 'com', 'org', 'ac', 'gov', 'net'].includes(labels[i])) i--;
  const sld = labels[i];
  if (KNOWN[sld]) return KNOWN[sld];
  return sld.charAt(0).toUpperCase() + sld.slice(1);
}

type RGB = [number, number, number];
const parseColors = (css: string): { rgb: RGB; w: number }[] => {
  const out: { rgb: RGB; w: number }[] = [];
  for (const m of css.matchAll(/#([0-9a-f]{3}|[0-9a-f]{6})\b/gi)) {
    const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
    out.push({ rgb: [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)], w: 1 });
  }
  for (const m of css.matchAll(/rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+([\d.]+))?\s*\)/gi)) {
    if (m[4] !== undefined && parseFloat(m[4]) < 0.5) continue;
    out.push({ rgb: [+m[1], +m[2], +m[3]], w: 1 });
  }
  return out;
};
const sat = ([r, g, b]: RGB) => {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx === 0 ? 0 : (mx - mn) / mx;
};
const dist = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const paletteCache = new Map<string, string[]>();
/** Two representative colours from a design's CSS: frequent, a little saturated, and clearly different from each other. */
export function paletteOf(css: string): string[] {
  const hit = paletteCache.get(css);
  if (hit) return hit;
  const counts = new Map<string, { rgb: RGB; n: number }>();
  for (const { rgb } of parseColors(css)) {
    const key = rgb.map((v) => Math.round(v / 16)).join(',');
    const cur = counts.get(key);
    if (cur) cur.n++;
    else counts.set(key, { rgb, n: 1 });
  }
  const ranked = [...counts.values()].sort((a, b) => b.n * (0.4 + sat(b.rgb)) - a.n * (0.4 + sat(a.rgb)));
  const first = ranked[0]?.rgb;
  const second = first ? ranked.find((c) => dist(c.rgb, first) > 70)?.rgb : undefined;
  const hex = (c: RGB) => `rgb(${c.join(',')})`;
  const res = first ? [hex(first), hex(second ?? first)] : [];
  if (paletteCache.size > 300) paletteCache.clear();
  paletteCache.set(css, res);
  return res;
}

const snippet = (t: string, n: number) => {
  const s = t.replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

// ------------------------------------------------------------------------------------------ pieces

export function Favicon({ host, favicons }: { host: string; favicons: Record<string, string> }) {
  if (host === GLOBAL_HOST) return <span className="favicon" aria-hidden="true"><GlobeIcon size={18} /></span>;
  const src = favicons[host];
  // ✦ when no icon could be saved for the site
  return src ? <img className="favicon" src={src} alt="" aria-hidden="true" /> : <span className="favicon" aria-hidden="true">✦</span>;
}

export function Search({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <div className="search" role="search">
      <SearchIcon size={20} />
      <input type="search" aria-label={label} placeholder={label} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export interface RowActions {
  activate: (d: Design, enabled: boolean) => void;
  excludeHere: (d: Design, excluded: boolean) => void;
  copyHere: (d: Design) => void;
  tryEverywhere: (d: Design) => void;
  share: (d: Design) => void;
  rename: (d: Design) => void;
  remove: (d: Design) => void;
  openChat: (c: Conversation) => void;
  /** Opens a community theme's page on the website. */
  viewTheme: (d: Design) => void;
}
export interface LibCtx {
  host: string | null;
  /** Does the design apply to the page that is open? (site, page and community scope rules) */
  fits: (d: Design) => boolean;
  busy: boolean;
  favicons: Record<string, string>;
  convoByDesign: Map<string, Conversation>;
  act: RowActions;
  fallbackSrc: string;
}

export function Thumb({ design, fallbackSrc }: { design: Design; fallbackSrc: string }) {
  const [broken, setBroken] = useState(false);
  const src = design.thumb && !broken ? design.thumb : fallbackSrc;
  return (
    <div className="thumb-box">
      <img src={src} alt="" loading="lazy" onError={() => src !== fallbackSrc && setBroken(true)} />
    </div>
  );
}

export function DesignRow({ d, ctx }: { d: Design; ctx: LibCtx }) {
  const { host, act } = ctx;
  const isGlobal = scopeOf(d) === 'global';
  const excludedHere = isGlobal && !!host && (d.excludedHosts ?? []).includes(host);
  const convo = ctx.convoByDesign.get(d.id);
  const colors = useMemo(() => paletteOf(d.css), [d.css]);
  const on = d.enabled && !excludedHere;
  const sameSite = !!host && (isGlobal || d.host === host);
  const sub = d.descriptor ?? (d.community ? `Community · by ${d.community.creator}` : snippet(d.prompt, 42));
  const where = scopeOf(d) === 'page' ? scopeLabel(d) : isGlobal ? 'All sites' : '';

  const items: MenuItem[] = [];
  if (convo) items.push({ label: 'Open chat', onSelect: () => act.openChat(convo) });
  if (host && !d.community && !(sameSite && ctx.fits(d))) items.push({ label: sameSite ? 'Use on this page' : 'Copy to this site', onSelect: () => act.copyHere(d), disabled: ctx.busy });
  if (host && !isGlobal && !d.community) items.push({ label: 'Try on all sites', onSelect: () => act.tryEverywhere(d), disabled: ctx.busy });
  if (isGlobal && host) items.push({ label: excludedHere ? 'Use on this site' : 'Skip on this site', onSelect: () => act.excludeHere(d, !excludedHere) });
  if (d.community) {
    // Someone else's theme: you can make your own editable copy (no AI call yet; a chat opens), or see it on the website.
    items.push({ label: sameSite ? 'Customize with AI' : 'Customize with AI (open the site first)', onSelect: () => act.copyHere(d), disabled: ctx.busy || !sameSite });
    items.push({ label: 'View on Whimsy Web', onSelect: () => act.viewTheme(d) });
  }
  if (!d.community) items.push({ label: 'Share…', onSelect: () => act.share(d), separator: items.length > 0 });
  items.push({ label: 'Rename', onSelect: () => act.rename(d) });
  items.push({ label: d.community ? 'Remove theme' : 'Delete', onSelect: () => act.remove(d), danger: true, separator: true });

  return (
    <li className={`drow${on ? ' on' : ''}`}>
      <Thumb design={d} fallbackSrc={ctx.fallbackSrc} />
      <div className="drow-text">
        <span className="drow-name" title={d.name}>{d.name}</span>
        <span className="drow-sub" title={d.prompt}>{[sub, where].filter(Boolean).join(' · ')}</span>
        {colors.length > 0 && (
          <span className="dots-row" aria-hidden="true">
            {colors.map((c, i) => <i key={i} style={{ background: c }} />)}
          </span>
        )}
      </div>
      <div className="drow-actions">
        <button
          className={`apply-btn${on ? ' active' : ''}`}
          aria-pressed={on}
          title={on ? 'On. Click to turn it off.' : excludedHere ? 'Off on this site. Click to use it here.' : 'Turn this design on'}
          onClick={() => (excludedHere ? act.excludeHere(d, false) : act.activate(d, !d.enabled))}
        >
          {on ? <><CheckIcon size={15} /> Active</> : excludedHere ? 'Use here' : 'Apply'}
        </button>
        <RowMenu label={`More for ${d.name}`} items={items} />
      </div>
    </li>
  );
}

export function GroupHead({ host, count, favicons }: { host: string; count: number; favicons: Record<string, string> }) {
  return (
    <h3 className="group-head">
      <Favicon host={host} favicons={favicons} />
      <span className="group-name" title={host === GLOBAL_HOST ? undefined : host}>{siteName(host)}</span>
      <span className="count" aria-label={`${count} ${count === 1 ? 'design' : 'designs'}`}>· {count}</span>
      <span className="rule" aria-hidden="true" />
    </h3>
  );
}

// ------------------------------------------------------------------------------------------ Library

export function LibraryView({ designs, ctx, query, setQuery, onExplore, header }: { designs: Design[]; ctx: LibCtx; query: string; setQuery: (v: string) => void; onExplore: () => void; header?: ReactNode }) {
  const q = query.trim().toLowerCase();
  const shown = q ? designs.filter((d) => `${d.name} ${siteName(d.host)} ${d.host} ${d.descriptor ?? ''} ${d.prompt}`.toLowerCase().includes(q)) : designs;
  // Alphabetical by the name people see, "All sites" first, and stable: editing something never moves it.
  const hosts = [...new Set(shown.map((d) => d.host))].sort((a, b) => Number(b === GLOBAL_HOST) - Number(a === GLOBAL_HOST) || byText(siteName(a), siteName(b)) || byText(a, b));
  return (
    <div className="lib">
      {header}
      <Search value={query} onChange={setQuery} label="Find a design…" />
      {designs.length === 0 ? (
        <div className="empty-note"><strong>No saved designs yet</strong>Describe a look in Chat and it will be saved here.</div>
      ) : shown.length === 0 ? (
        <div className="empty-note"><strong>Nothing matches “{query.trim()}”</strong>Try a site name or part of a design name.</div>
      ) : (
        hosts.map((h) => {
          const list = shown.filter((d) => d.host === h).sort(byName);
          return (
            <section className="group" key={h}>
              <GroupHead host={h} count={list.length} favicons={ctx.favicons} />
              <ul className="rows">{list.map((d) => <DesignRow key={d.id} d={d} ctx={ctx} />)}</ul>
            </section>
          );
        })
      )}
      <button className="explore-link" onClick={onExplore}>
        Explore community themes <ArrowRightIcon size={18} />
      </button>
    </div>
  );
}

// ------------------------------------------------------------------------------------------ History

const dayStart = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
function dayLabel(t: number, now: number): string {
  const diff = Math.round((dayStart(now) - dayStart(t)) / 86_400_000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'Earlier this week';
  return new Date(t).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}
const timeOf = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export function HistoryView({ convos, designsById, favicons, currentId, query, setQuery, onOpen, onRemove, onNew, now = Date.now() }: { convos: Conversation[]; designsById: Map<string, Design>; favicons: Record<string, string>; currentId: string | null; query: string; setQuery: (v: string) => void; onOpen: (c: Conversation) => void; onRemove: (c: Conversation) => void; onNew: () => void; now?: number }) {
  const q = query.trim().toLowerCase();
  const shown = (q ? convos.filter((c) => `${c.title} ${siteName(c.host)} ${c.host}`.toLowerCase().includes(q)) : convos).slice().sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
  const groups: { label: string; items: Conversation[] }[] = [];
  for (const c of shown) {
    const label = dayLabel(c.updatedAt, now);
    const g = groups.find((x) => x.label === label);
    if (g) g.items.push(c);
    else groups.push({ label, items: [c] });
  }
  return (
    <div className="lib">
      <div className="new-chat-row">
        <button className="apply-btn" onClick={onNew}>New chat</button>
      </div>
      <Search value={query} onChange={setQuery} label="Find a chat…" />
      {convos.length === 0 ? (
        <div className="empty-note"><strong>No chats yet</strong>Your conversations with Whimsy Web will show up here.</div>
      ) : shown.length === 0 ? (
        <div className="empty-note"><strong>Nothing matches “{query.trim()}”</strong>Try a site name or part of a chat title.</div>
      ) : (
        groups.map((g) => (
          <section key={g.label}>
            <h3 className="day-head">{g.label}</h3>
            <ul className="rows">
              {g.items.map((c) => {
                const design = c.designId ? designsById.get(c.designId) : undefined;
                const last = [...c.messages].reverse().find((m) => m.role === 'assistant') ?? c.messages[c.messages.length - 1];
                return (
                  <li key={c.id} className={`hrow${c.id === currentId ? ' on' : ''}`}>
                    <Favicon host={c.host} favicons={favicons} />
                    <button className="hrow-main" onClick={() => onOpen(c)}>
                      <span className="hrow-title">{c.title}</span>
                      {last && <span className="hrow-snippet">{snippet(last.text, 90)}</span>}
                      <span className="hrow-meta">
                        <span>{siteName(c.host)}</span>
                        <span>·</span>
                        <span>{timeOf(c.updatedAt)}</span>
                        {c.designId && (design ? <><span>·</span><span title={design.name}>{snippet(design.name, 22)}</span></> : <><span>·</span><span className="gone">Design deleted</span></>)}
                      </span>
                    </button>
                    <button className="more-btn" aria-label={`Delete chat ${c.title}`} title="Delete chat" onClick={() => onRemove(c)}>
                      <TrashIcon size={17} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
