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
ok('no externally_connectable yet: no web page or other extension can message this one', !('externally_connectable' in m));
ok('no remotely hosted code or web-accessible resources', !('web_accessible_resources' in m) && !('content_security_policy' in m));
ok('every declared icon file exists', Object.values(m.icons).every((p) => existsSync('public/' + p)) && Object.values(m.action.default_icon).every((p) => existsSync('public/' + p)));
ok('service worker and side panel entry points exist after a build source-wise', m.background.service_worker === 'background.js' && m.side_panel.default_path === 'sidepanel.html' && existsSync('public/sidepanel.html'));

console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);
