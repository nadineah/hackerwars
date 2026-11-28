/**
 * Icons people can swap a site's icon for in Edit Mode. Drawn for Whimsy Web on a 24x24 grid with round 2px strokes.
 * Used as a CSS mask, so the icon still takes the colour picked for it (its `color`).
 */
export const ICON_SET: [name: string, label: string, body: string][] = [
  // fun
  ['heart', 'Heart', '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>'],
  ['star', 'Star', '<path d="M12 3l2.7 5.6 6.3.7-4.7 4.3 1.3 6.4L12 16.9 6.4 20l1.3-6.4L3 9.3l6.3-.7z"/>'],
  ['sparkle', 'Sparkle', '<path d="M12 3l2 7 7 2-7 2-2 7-2-7-7-2 7-2z"/>'],
  ['flower', 'Flower', '<circle cx="12" cy="12" r="2.5"/><circle cx="12" cy="6" r="3"/><circle cx="18" cy="12" r="3"/><circle cx="12" cy="18" r="3"/><circle cx="6" cy="12" r="3"/>'],
  ['leaf', 'Leaf', '<path d="M5 19C5 10 11 4 20 4c0 9-6 15-15 15zM5 19l8-8"/>'],
  ['sun', 'Sun', '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'],
  ['moon', 'Moon', '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'],
  ['cloud', 'Cloud', '<path d="M7 18a4.5 4.5 0 0 1-.5-9A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 8.5z"/>'],
  ['rainbow', 'Rainbow', '<path d="M2 18a10 10 0 0 1 20 0M6 18a6 6 0 0 1 12 0M10 18a2 2 0 0 1 4 0"/>'],
  ['crown', 'Crown', '<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/>'],
  ['gem', 'Gem', '<path d="M6 4h12l3 5-9 11L3 9z"/><path d="M3 9h18M9 4l3 16 3-16"/>'],
  ['fire', 'Fire', '<path d="M12 22c4 0 7-3 7-7 0-5-5-7-5-12-3 2-5 5-5 8-1-1-2-2-2-4-2 2-2 5-2 8 0 4 3 7 7 7z"/>'],
  ['bolt', 'Lightning', '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>'],
  ['butterfly', 'Butterfly', '<path d="M12 7v13"/><path d="M12 11C10 5 3 3 3 8c0 3 4 4 9 3zM12 11c2-6 9-8 9-3 0 3-4 4-9 3zM12 12c-3 1-7 3-5 7 1 1 4-1 5-7zM12 12c3 1 7 3 5 7-1 1-4-1-5-7z"/>'],
  ['paw', 'Paw', '<ellipse cx="12" cy="16" rx="4" ry="3.5"/><circle cx="6" cy="10" r="2"/><circle cx="10" cy="6" r="2"/><circle cx="14" cy="6" r="2"/><circle cx="18" cy="10" r="2"/>'],
  ['cat', 'Cat', '<path d="M5 20c-1-4-1-8 0-15l4 4h6l4-4c1 7 1 11 0 15z"/><path d="M9.5 14h.01M14.5 14h.01"/>'],
  ['mushroom', 'Mushroom', '<path d="M3 12a9 8 0 0 1 18 0z"/><path d="M9 12v6a3 3 0 0 0 6 0v-6"/>'],
  ['ghost', 'Ghost', '<path d="M5 21V10a7 7 0 0 1 14 0v11l-2.3-2-2.4 2-2.3-2-2.3 2-2.4-2z"/><path d="M9.5 10h.01M14.5 10h.01"/>'],
  ['cake', 'Cake', '<path d="M4 21v-8h16v8zM4 17c2 1 4-1 6 0s4 1 6 0 4-1 4 0M12 13V9M12 6.5c-1-1 0-2.5 0-2.5s1 1.5 0 2.5"/>'],
  ['gift', 'Gift', '<rect x="3" y="8" width="18" height="4"/><path d="M5 12v9h14v-9M12 8v13M12 8S10 3 7.5 4 8 8 12 8zM12 8s2-5 4.5-4S16 8 12 8z"/>'],
  ['balloon', 'Balloon', '<path d="M12 16c-4 0-6-3.5-6-7a6 6 0 0 1 12 0c0 3.5-2 7-6 7zM12 16l-1 2h2z"/><path d="M12 18c0 2-2 2-1 4"/>'],
  ['rocket', 'Rocket', '<path d="M12 2c2.8 2.3 4 5.7 4 9.5V17H8v-5.5C8 7.7 9.2 4.3 12 2z"/><path d="M8 12.5l-3 3.5v3l3-2M16 12.5l3 3.5v3l-3-2M10.5 20l1.5 2 1.5-2"/><circle cx="12" cy="9.5" r="1.6"/>'],
  ['planet', 'Planet', '<circle cx="12" cy="12" r="6"/><path d="M5 15.5C1.5 18 2 20 5 19.5c3-.5 8-3 11.5-6S22 6 19 5.5c-1-.2-2.5.3-4 1"/>'],
  ['coffee', 'Coffee', '<path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM17 10h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 3v3M12 3v3"/>'],
  ['smile', 'Smile', '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9.5h.01M15 9.5h.01"/>'],
  // arrows
  ['arrow', 'Arrow', '<path d="M5 12h14M13 6l6 6-6 6"/>'],
  ['back', 'Back', '<path d="M19 12H5M11 6l-6 6 6 6"/>'],
  ['chevron-right', 'Chevron right', '<path d="M9 6l6 6-6 6"/>'],
  ['chevron-left', 'Chevron left', '<path d="M15 6l-6 6 6 6"/>'],
  ['chevron-down', 'Chevron down', '<path d="M6 9l6 6 6-6"/>'],
  ['chevron-up', 'Chevron up', '<path d="M6 15l6-6 6 6"/>'],
  ['external', 'Opens elsewhere', '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'],
  ['refresh', 'Refresh', '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>'],
  ['download', 'Download', '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'],
  ['upload', 'Upload', '<path d="M12 15V4M7 9l5-5 5 5M5 20h14"/>'],
  ['share', 'Share', '<path d="M12 3v12M7 8l5-5 5 5M5 14v6h14v-6"/>'],
  // actions
  ['home', 'Home', '<path d="M3 11l9-7 9 7M5 10v10h5v-6h4v6h5V10"/>'],
  ['search', 'Search', '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>'],
  ['menu', 'Menu', '<path d="M4 6h16M4 12h16M4 18h16"/>'],
  ['dots', 'More', '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>'],
  ['plus', 'Plus', '<path d="M12 5v14M5 12h14"/>'],
  ['close', 'Close', '<path d="M6 6l12 12M18 6L6 18"/>'],
  ['check', 'Check', '<path d="M4 12l5 5L20 6"/>'],
  ['pencil', 'Edit', '<path d="M4 20l1-4L16 5l3 3L8 19zM14 7l3 3"/>'],
  ['trash', 'Delete', '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'],
  ['link', 'Link', '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'],
  ['filter', 'Filter', '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>'],
  ['lock', 'Lock', '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'],
  ['eye', 'Show', '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'],
  ['gear', 'Settings', '<circle cx="12" cy="12" r="3"/><path d="M10.3 3h3.4l.5 2.4 1.8.8 2-1.4 2.4 2.4-1.4 2 .8 1.8 2.4.5v3.4l-2.4.5-.8 1.8 1.4 2-2.4 2.4-2-1.4-1.8.8-.5 2.4h-3.4l-.5-2.4-1.8-.8-2 1.4-2.4-2.4 1.4-2-.8-1.8L3 13.7v-3.4l2.4-.5.8-1.8-1.4-2 2.4-2.4 2 1.4 1.8-.8z"/>'],
  ['bookmark', 'Bookmark', '<path d="M6 3h12v18l-6-4-6 4z"/>'],
  ['flag', 'Flag', '<path d="M5 21V4M5 4h12l-2 4 2 4H5"/>'],
  ['info', 'Info', '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'],
  ['warning', 'Warning', '<path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17h.01"/>'],
  ['question', 'Help', '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01"/>'],
  ['thumb', 'Thumbs up', '<path d="M7 10v10H4V10zM7 10l4-7a2 2 0 0 1 3 2l-1 4h6a2 2 0 0 1 2 2.3l-1.3 7A2 2 0 0 1 16.7 20H7"/>'],
  // people and messages
  ['user', 'Person', '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'],
  ['mail', 'Mail', '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>'],
  ['chat', 'Chat', '<path d="M4 5h16v11H9l-5 4z"/>'],
  ['send', 'Send', '<path d="M21 3L3 10l7 3 3 7z"/><path d="M10 13l11-10"/>'],
  ['phone', 'Phone', '<path d="M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 3 5a2 2 0 0 1 2-2z"/>'],
  ['bell', 'Bell', '<path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 21a2 2 0 0 0 4 0"/>'],
  ['pin', 'Place', '<path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>'],
  ['globe', 'Globe', '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>'],
  ['calendar', 'Calendar', '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'],
  ['clock', 'Clock', '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'],
  // media
  ['play', 'Play', '<path d="M7 4l13 8-13 8z"/>'],
  ['pause', 'Pause', '<path d="M7 4h3v16H7zM14 4h3v16h-3z"/>'],
  ['music', 'Music', '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>'],
  ['volume', 'Sound', '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>'],
  ['camera', 'Camera', '<path d="M3 8h4l2-3h6l2 3h4v12H3z"/><circle cx="12" cy="13" r="3.5"/>'],
  ['image', 'Picture', '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9.5" r="1.5"/><path d="M21 16l-5-5-11 9"/>'],
  ['video', 'Video', '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/>'],
  // shopping
  ['cart', 'Cart', '<circle cx="9" cy="20" r="1.5"/><circle cx="17" cy="20" r="1.5"/><path d="M3 4h2l2.4 11h10.6L20 8H6.2"/>'],
  ['bag', 'Bag', '<path d="M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2"/>'],
  ['tag', 'Price tag', '<path d="M3 3h8l10 10-8 8L3 11z"/><circle cx="7.5" cy="7.5" r="1.5"/>'],
];

/** The picker's headings: each lists its icons in order. */
export const ICON_GROUPS: { title: string; names: string[] }[] = [
  { title: 'Fun', names: ['heart', 'star', 'sparkle', 'flower', 'leaf', 'sun', 'moon', 'cloud', 'rainbow', 'crown', 'gem', 'fire', 'bolt', 'butterfly', 'paw', 'cat', 'mushroom', 'ghost', 'cake', 'gift', 'balloon', 'rocket', 'planet', 'coffee', 'smile'] },
  { title: 'Arrows', names: ['arrow', 'back', 'chevron-right', 'chevron-left', 'chevron-down', 'chevron-up', 'external', 'refresh', 'download', 'upload', 'share'] },
  { title: 'Actions', names: ['home', 'search', 'menu', 'dots', 'plus', 'close', 'check', 'pencil', 'trash', 'link', 'filter', 'lock', 'eye', 'gear', 'bookmark', 'flag', 'info', 'warning', 'question', 'thumb'] },
  { title: 'People & messages', names: ['user', 'mail', 'chat', 'send', 'phone', 'bell', 'pin', 'globe', 'calendar', 'clock'] },
  { title: 'Media', names: ['play', 'pause', 'music', 'volume', 'camera', 'image', 'video'] },
  { title: 'Shopping', names: ['cart', 'bag', 'tag'] },
];

/** Drawn as lines (open paths, or details a filled shape would hide): kept as lines when "Filled in" is on. */
const LINE_ONLY = new Set(['leaf', 'sun', 'rainbow', 'gem', 'cake', 'gift', 'planet', 'smile', 'arrow', 'back', 'chevron-right', 'chevron-left', 'chevron-down', 'chevron-up', 'external', 'refresh', 'download', 'upload', 'share', 'home', 'menu', 'plus', 'close', 'check', 'trash', 'link', 'lock', 'eye', 'gear', 'info', 'warning', 'question', 'mail', 'pin', 'globe', 'calendar', 'clock', 'music', 'volume', 'camera', 'image', 'cart']);

/** Can it be drawn filled in (a closed shape with nothing inside it to lose)? */
export const canFill = (name: string): boolean => !LINE_ONLY.has(name);

/** Other words people may search for. */
const ICON_WORDS: Record<string, string> = {
  heart: 'love like favourite favorite', star: 'favourite favorite rating', sparkle: 'magic new shine', sun: 'light day bright', moon: 'dark night',
  bolt: 'flash power energy fast', paw: 'pet dog animal', cat: 'pet kitten animal', cake: 'birthday party', gift: 'present birthday', balloon: 'party',
  rocket: 'launch space', planet: 'space world', coffee: 'cup tea drink', smile: 'happy face emoji', gem: 'diamond jewel premium', fire: 'hot flame trending',
  arrow: 'next forward right go', back: 'previous left return', 'chevron-right': 'next more', 'chevron-left': 'previous', 'chevron-down': 'open expand dropdown more',
  'chevron-up': 'close collapse top', external: 'new tab window open link', refresh: 'reload again redo', search: 'find magnifier look', menu: 'hamburger navigation',
  dots: 'more options ellipsis', plus: 'add new create', close: 'x cross cancel remove', check: 'tick done yes ok', pencil: 'edit write change', trash: 'delete bin remove',
  link: 'chain url', filter: 'funnel sort', lock: 'secure private password padlock', eye: 'see view look visible', gear: 'settings cog options', bookmark: 'save',
  info: 'about information', warning: 'alert danger caution error', question: 'help faq', thumb: 'like good approve', user: 'person account profile login',
  mail: 'email envelope message newsletter', chat: 'message comment talk speech', send: 'paper plane submit', phone: 'call contact', bell: 'notification alert',
  pin: 'location place map address', globe: 'world language international web', calendar: 'date event schedule', clock: 'time hour watch', volume: 'sound speaker audio',
  camera: 'photo picture', image: 'picture photo gallery', video: 'film movie', cart: 'basket trolley shop buy', bag: 'shop shopping buy', tag: 'price sale label discount',
  download: 'save get', upload: 'send put', share: 'send export', home: 'house start main', music: 'song note audio', play: 'start video', pause: 'stop',
};

/** The icons matching what was typed (by label, name or other words); null when nothing is typed (all are shown). */
export function iconMatches(q: string): Set<string> | null {
  const w = q.trim().toLowerCase();
  if (!w) return null;
  return new Set(ICON_SET.filter(([n, l]) => `${n} ${l} ${ICON_WORDS[n] ?? ''}`.toLowerCase().includes(w)).map(([n]) => n));
}

/** An SVG file's text as a data: URL that a CSS url() can hold as is. */
export const svgDataUrl = (svg: string): string =>
  // no characters a CSS url() would need to escape
  `data:image/svg+xml,${encodeURIComponent(svg).replace(/[()'!*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;

const svgUrl = (body: string, filled: boolean): string => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="${filled ? 'black' : 'none'}" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  return svgDataUrl(svg);
};

/** The icon as an SVG file in a data: URL (outline, or filled in; a line icon stays lines). */
export function iconUrl(name: string, filled = false): string | null {
  const i = ICON_SET.find(([n]) => n === name);
  if (!i) return null;
  return svgUrl(i[2], filled && canFill(name));
}

/** Which built-in icon a mask value shows, if any (also one saved filled in before it was kept as lines). */
export function iconInMask(mask: string | undefined): { name: string; filled: boolean } | null {
  if (!mask) return null;
  const m = mask.replace(/["'\\]/g, '');
  for (const [n, , body] of ICON_SET) {
    if (m.includes(svgUrl(body, false))) return { name: n, filled: false };
    if (m.includes(svgUrl(body, true))) return { name: n, filled: true };
  }
  return null;
}
