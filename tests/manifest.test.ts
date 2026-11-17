import { existsSync, readFileSync } from 'node:fs';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra)?.slice(0, 300));
};
const m = JSON.parse(readFileSync('public/manifest.json', 'utf8'));

ok('manifest v3', m.manifest_version === 3);
ok('permissions are exactly the audited set', JSON.stringify([...m.permissions].sort()) === JSON.stringify(['activeTab', 'sidePanel', 'storage', 'unlimitedStorage']), m.permissions);
ok('unlimitedStorage is present (conversation snapshots can exceed the 10 MB default)', m.permissions.includes('unlimitedStorage'));
ok('no tabs / scripting / webRequest / cookies / history / downloads permission', !['tabs', 'scripting', 'webRequest', 'cookies', 'history', 'downloads', 'declarativeNetRequest', 'nativeMessaging', 'debugger'].some((p) => m.permissions.includes(p)), m.permissions);
ok('host permissions are the documented <all_urls>', JSON.stringify(m.host_permissions) === JSON.stringify(['<all_urls>']));
ok('content script runs only on http(s) in the top frame at document_start', m.content_scripts.length === 1 && JSON.stringify(m.content_scripts[0].matches) === JSON.stringify(['http://*/*', 'https://*/*']) && m.content_scripts[0].all_frames === false && m.content_scripts[0].run_at === 'document_start', m.content_scripts);
const ec = m.externally_connectable;
ok('externally_connectable lists only exact website origins (no wildcards, no other extensions, no <all_urls>)', !!ec && !('ids' in ec) && ec.matches.length >= 1 && ec.matches.every((p: string) => /^https?:\/\/[a-z0-9.-]+(:\d+)?\/\*$/.test(p) && !p.includes('*.') && !p.startsWith('*')), ec);
ok('the checked-in default only allows localhost (production origins are injected by the build)', ec.matches.every((p: string) => p.startsWith('http://localhost')), ec);
ok('manifest version is at least what published themes require', m.version === '0.2.0', m.version);
ok('no remotely hosted code, no custom CSP, no sandbox pages, no web-accessible resources', !('web_accessible_resources' in m) && !('content_security_policy' in m) && !('sandbox' in m));
ok('every declared icon file exists', Object.values(m.icons).every((p) => existsSync('public/' + p)) && Object.values(m.action.default_icon).every((p) => existsSync('public/' + p)));
ok('service worker and side panel entry points exist after a build source-wise', m.background.service_worker === 'background.js' && m.side_panel.default_path === 'sidepanel.html' && existsSync('public/sidepanel.html'));

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
