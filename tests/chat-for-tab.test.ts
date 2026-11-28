// Which chat the panel shows for the tab on screen (docs/spec-chat-follows-tab.md, section 1).
import { chatForTab, chatTarget, confirmPin, lastChatFor, pinHolds, themesOn, type Pin, type TabRef } from '../src/sidepanel/chatForTab';
import type { Conversation, Design } from '../src/shared/types';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${!cond && extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`);
};

const design = (id: string, over: Partial<Design> = {}): Design => ({ id, host: 'a.com', name: id, prompt: '', css: '', ops: [], enabled: true, createdAt: 1, updatedAt: 1, ...over }) as Design;
const convo = (id: string, designId: string | undefined, over: Partial<Conversation> = {}): Conversation => ({ id, host: 'a.com', title: id, createdAt: 1, updatedAt: 1, designId, messages: [], ...over });
const tab = (host: string | null, path = '/', id = 1): TabRef => ({ id, host, path });

const site = design('site', { scope: 'site', updatedAt: 5 });
const page = design('page', { scope: 'page', path: '/watch', updatedAt: 2 });
const global = design('global', { host: '*', scope: 'global', updatedAt: 9 });
const convos = [convo('c-site', 'site'), convo('c-page', 'page', { scope: 'page', path: '/watch' }), convo('c-global', 'global', { host: '*', scope: 'global' })];
const all = [site, page, global];
const show = (t: TabRef, pin: Pin | null = null, designs = all, cs = convos, memory: Record<string, string> = {}) => chatForTab({ tab: t, pin, convos: cs, designs, memory });

// most specific theme wins
ok('This page beats Whole site and All sites', JSON.stringify(show(tab('a.com', '/watch'))) === JSON.stringify({ kind: 'convo', id: 'c-page', why: 'theme' }));
ok('Whole site beats All sites on other pages', (show(tab('a.com', '/home')) as { id?: string }).id === 'c-site');
ok('All sites shows on a site with no theme of its own', (show(tab('b.com')) as { id?: string }).id === 'c-global');
ok('order list: page, site, global', themesOn(all, 'a.com', '/watch').map((d) => d.id).join() === 'page,site,global');
const site2 = design('site2', { scope: 'site', updatedAt: 1, lastActiveAt: 50 });
ok('same level: the one switched on or used most recently first', themesOn([site, site2], 'a.com', '/').map((d) => d.id).join() === 'site2,site');

// what does not count
ok('a theme that is off does not count', (show(tab('a.com', '/home'), null, [{ ...site, enabled: false }, global]) as { id?: string }).id === 'c-global');
ok('an All Sites theme skipped on this site does not count', show(tab('b.com'), null, [{ ...global, excludedHosts: ['b.com'] }]).kind === 'fresh');
ok('a theme without a chat is skipped', (show(tab('a.com', '/home'), null, all, convos.filter((c) => c.id !== 'c-site')) as { id?: string }).id === 'c-global');
ok('not a website: a fresh chat', show(tab(null)).kind === 'fresh');

// nothing on: fresh, with the last chat offered
const off = all.map((d) => ({ ...d, enabled: false }));
const fresh = show(tab('a.com', '/home'), null, off, [...convos, convo('c-old', 'x', { updatedAt: 99 })]);
ok('no theme on: a fresh chat', fresh.kind === 'fresh' && fresh.why === 'nothing');
ok('...offering the newest chat for this site', fresh.kind === 'fresh' && fresh.continueId === 'c-old', fresh);
ok('...or the one remembered for it', lastChatFor(tab('a.com'), convos, { 'a.com': 'c-site' }) === 'c-site');
ok('All Sites chats are not offered as "this site\'s" chat', lastChatFor(tab('b.com'), convos, {}) === null);

// pins: a chat opened on purpose
const pin: Pin = { convoId: 'c-global', host: 'a.com', path: '/watch' };
ok('a pin beats the theme rule', (show(tab('a.com', '/watch'), pin) as { id?: string }).id === 'c-global');
ok('a pin ends when the tab moves to another page', (show(tab('a.com', '/other'), pin) as { id?: string }).id === 'c-site');
ok('...or another site', !pinHolds(pin, tab('b.com', '/watch')));
ok('a fresh pin (New chat) shows a fresh chat even with themes on', JSON.stringify(show(tab('a.com', '/watch'), { convoId: null, host: 'a.com', path: '/watch' })) === JSON.stringify({ kind: 'fresh', continueId: null, why: 'pinned' }));
ok('a pin to a deleted chat falls back to the rule', (show(tab('a.com', '/watch'), { convoId: 'gone', host: 'a.com', path: '/watch' }) as { id?: string }).id === 'c-page');
const loading: Pin = { convoId: 'c-site', host: null, path: null };
ok('a pin made while the tab was loading holds', pinHolds(loading, tab('a.com', '/en')));
ok('...and is confirmed where the tab lands (redirects allowed)', JSON.stringify(confirmPin(loading, tab('a.com', '/en'))) === JSON.stringify({ convoId: 'c-site', host: 'a.com', path: '/en' }));

// where a chat's tab is
ok('page chat: that exact page', JSON.stringify(chatTarget(convos[1], page)) === JSON.stringify({ host: 'a.com', path: '/watch', exact: true }));
ok('site chat: any page on the site', JSON.stringify(chatTarget(convos[0], site)) === JSON.stringify({ host: 'a.com', path: '/', exact: false }));
ok('All Sites chat: the site it was made on', chatTarget(convo('g', 'global', { host: '*', scope: 'global', pageContext: { host: 'made.com', path: '/', text: '' } }), global).host === 'made.com');
ok('All Sites chat with no known home: no particular site', chatTarget(convos[2], global).host === null);

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
