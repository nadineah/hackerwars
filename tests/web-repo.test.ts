import { mkdtempSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

// Point uploads at a throwaway directory BEFORE the modules read it.
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'ww-test-'));

import { openDb, tx, run, get, all } from '../web/src/lib/db';
import * as accounts from '../web/src/lib/repo/accounts';
import * as themes from '../web/src/lib/repo/themes';
import * as moderation from '../web/src/lib/repo/moderation';
import { checkRateLimit, enforceRateLimit } from '../web/src/lib/ratelimit';
import { processImage, sniffImage, storeMedia, readMedia, requireOwnMedia, deleteMediaFiles } from '../web/src/lib/media';
import { AppError, compareVersions, normalizeTags, slugify, validateUsername } from '../web/src/lib/validation';
import { versionHash } from '../theme-core/src';

let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra)?.slice(0, 300));
};
/** Asserts a call throws an AppError with the given HTTP status. */
async function throwsStatus(name: string, status: number, fn: () => unknown) {
  try {
    await fn();
    ok(name, false, 'did not throw');
  } catch (e) {
    ok(name, e instanceof AppError && e.status === status, e instanceof AppError ? `${e.status} ${e.message}` : String(e));
  }
}

const GOOD_CSS = 'body{background:#faf6ee;color:#3b2f3f}a{color:#7b4b94}';
const meta = (over: Record<string, unknown> = {}) => ({
  title: 'Paper Trail', description: 'Warm paper tones.', hostname: 'en.wikipedia.org', tags: ['warm', 'paper'], appearance: 'light', license: 'cc-by-4.0', compatNotes: '', ...over,
});
const ver = (over: Record<string, unknown> = {}) => ({ css: GOOD_CSS, pathScope: { mode: 'prefix', paths: ['/wiki'] }, changeNotes: 'first', ...over });

async function png(w = 800, h = 500, color = '#ffffff') {
  return sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
}

(async () => {
  const db = openDb(':memory:');
  const mk = (email: string) => accounts.createUser(db, { email });
  const alice = mk('alice@example.com');
  const bob = mk('bob@example.com');
  const mod = mk('mod@example.com');
  accounts.syncModerators(db, ['MOD@example.com']);

  // =================================================================== accounts + privacy
  const ap = accounts.getProfile(db, alice.id)!;
  ok('new profiles get a private placeholder handle, not the email name', /^creator-[0-9a-f]{6}$/.test(ap.username) && !ap.username.includes('alice'), ap.username);
  ok('profile objects carry no email', !('email' in ap) && !JSON.stringify(ap).includes('example.com'));
  await throwsStatus('duplicate email (case-insensitive) is rejected', 500, () => { try { return accounts.createUser(db, { email: 'ALICE@example.com' }); } catch (e) { throw new AppError(500, String(e)); } });
  await throwsStatus('invalid email is rejected', 400, () => accounts.createUser(db, { email: 'not-an-email' }));
  ok('moderators are synced case-insensitively from config', accounts.getUserById(db, mod.id)!.role === 'moderator' && accounts.getUserById(db, alice.id)!.role === 'user');

  const up = accounts.updateProfile(db, alice.id, { username: 'Alice_Art', displayName: 'Alice', bio: 'I like paper.' });
  ok('profile update normalizes username to lowercase', up.username === 'alice_art' && up.displayName === 'Alice');
  await throwsStatus('taken username is a 409', 409, () => accounts.updateProfile(db, bob.id, { username: 'ALICE_ART', displayName: 'Bob', bio: '' }));
  for (const bad of ['ab', 'a'.repeat(25), 'has space', 'UPPER!!', '-lead', 'admin', 'whimsyweb', 'login']) {
    await throwsStatus(`username ${JSON.stringify(bad)} is rejected`, 400, () => validateUsername(bad));
  }
  await throwsStatus('empty display name is rejected', 400, () => accounts.updateProfile(db, bob.id, { username: 'bobby', displayName: '   ', bio: '' }));
  const ctl = accounts.updateProfile(db, bob.id, { username: 'bobby', displayName: 'Bo\u0000b‮', bio: 'x'.repeat(500) });
  ok('control/bidi characters are stripped and the bio is capped', ctl.displayName === 'Bob' && ctl.bio.length === 280, ctl);

  // =================================================================== drafts are private
  const d = await themes.createDraft(db, alice.id, meta(), ver());
  ok('a new draft is created in draft status with a valid version 1', d.status === 'draft' && d.draft?.version === 1 && d.draft.validationStatus === 'valid', d);
  ok('slug derives from the title', d.slug === 'paper-trail');
  const d2 = await themes.createDraft(db, alice.id, meta(), ver());
  ok('same title gets a unique slug', d2.slug === 'paper-trail-2', d2.slug);
  ok('the gallery never lists drafts', themes.listPublishedThemes(db).total === 0);
  ok('a draft slug resolves to nothing for the public', themes.getPublishedThemeBySlug(db, d.slug) === null);
  await throwsStatus('a stranger gets 404 (not 403) for someone else\'s draft', 404, () => themes.getThemeForOwner(db, bob.id, d.id));
  ok('the extension payload endpoint does not serve drafts', (await themes.getVersionPayload(db, d.id)) === null && (await themes.getVersionPayload(db, d.id, d.draft!.id)) === null);

  // draft with bad CSS is saved but flagged
  const bad = await themes.createDraft(db, alice.id, meta({ title: 'Broken One' }), ver({ css: '@import url(https://evil.example/x.css);a{background:url(https://evil.example/p)}' }));
  ok('an invalid draft is saved, flagged invalid, with specific errors', bad.draft!.validationStatus === 'invalid' && bad.draft!.validationReport.errors.some((e) => e.code === 'import') && bad.draft!.validationReport.errors.some((e) => e.code === 'external-url'), bad.draft!.validationReport);
  await throwsStatus('unknown / unsupported website is rejected', 400, () => themes.createDraft(db, alice.id, meta({ hostname: 'evil.example.com' }), ver()));
  await throwsStatus('a bank is not a supported website', 400, () => themes.createDraft(db, alice.id, meta({ hostname: 'www.chase.com' }), ver()));
  await throwsStatus('wildcard hostname is rejected', 400, () => themes.createDraft(db, alice.id, meta({ hostname: '*.wikipedia.org' }), ver()));
  await throwsStatus('unknown license is rejected', 400, () => themes.createDraft(db, alice.id, meta({ license: 'do-whatever' }), ver()));
  await throwsStatus('short title is rejected', 400, () => themes.createDraft(db, alice.id, meta({ title: 'ab' }), ver()));
  const sens = await themes.createDraft(db, alice.id, meta({ title: 'Login Theme' }), ver({ pathScope: { mode: 'prefix', paths: ['/login'] } }));
  ok('a scope covering a sign-in path makes the version invalid', sens.draft!.validationStatus === 'invalid' && sens.draft!.validationReport.errors.some((e) => e.code === 'scope'), sens.draft!.validationReport);

  // =================================================================== ownership
  await throwsStatus('stranger cannot edit metadata', 404, () => themes.updateMeta(db, bob.id, d.id, meta({ title: 'Hijacked' })));
  await throwsStatus('stranger cannot save a draft version', 404, () => themes.saveDraftVersion(db, bob.id, d.id, ver({ css: 'a{color:red}' })));
  await throwsStatus('stranger cannot publish', 404, () => themes.publish(db, bob.id, d.id, { permissionConfirmed: true }));
  await throwsStatus('stranger cannot delete', 404, () => themes.deleteTheme(db, bob.id, d.id));
  await throwsStatus('stranger cannot unpublish', 404, () => themes.unpublishByOwner(db, bob.id, d.id));
  const ownMedia = storeMedia(db, alice.id, await processImage(await png(), 'preview'));
  const bobMedia = storeMedia(db, bob.id, await processImage(await png(), 'preview'));
  await throwsStatus('stranger cannot attach previews to your theme', 404, () => themes.addPreview(db, bob.id, d.id, bobMedia.id, 'after', ''));
  await throwsStatus('you cannot attach someone else\'s uploaded image', 403, () => themes.addPreview(db, alice.id, d.id, bobMedia.id, 'after', ''));
  await throwsStatus('attaching a non-existent image is a 404', 404, () => themes.addPreview(db, alice.id, d.id, crypto.randomUUID(), 'after', ''));
  const metaBefore = themes.getThemeForOwner(db, alice.id, d.id);
  ok('failed hijack attempts changed nothing', metaBefore.title === 'Paper Trail');
  const upd = themes.updateMeta(db, alice.id, d.id, meta({ title: 'Paper Trail', hostname: 'news.ycombinator.com', description: 'Updated.' }));
  ok('the target website cannot be changed after creation', upd.hostname === 'en.wikipedia.org' && upd.description === 'Updated.', upd.hostname);

  // =================================================================== publish checklist
  let pc = themes.publishChecks(db, alice.id, d.id, false);
  ok('publish is blocked without a preview and without the permission confirmation', !pc.ok && pc.problems.some((p) => /preview/i.test(p)) && pc.problems.some((p) => /right to share/i.test(p)), pc);
  await throwsStatus('server refuses to publish without a preview', 400, () => themes.publish(db, alice.id, d.id, { permissionConfirmed: true }));
  themes.addPreview(db, alice.id, d.id, ownMedia.id, 'after', 'After');
  await throwsStatus('server refuses to publish without confirming permission', 400, () => themes.publish(db, alice.id, d.id, { permissionConfirmed: false }));
  await throwsStatus('server refuses to publish invalid CSS', 400, async () => { themes.addPreview(db, alice.id, bad.id, ownMedia.id, 'after', ''); return themes.publish(db, alice.id, bad.id, { permissionConfirmed: true }); });

  const pub = themes.publish(db, alice.id, d.id, { permissionConfirmed: true });
  ok('publishing makes the theme public with version 1 current', pub.status === 'published' && pub.current?.version === 1 && pub.draft === null, pub);
  ok('the published theme appears in the gallery with real data', themes.listPublishedThemes(db).total === 1 && themes.getPublishedThemeBySlug(db, 'paper-trail')?.creator.username === 'alice_art');
  ok('public detail never exposes a draft version', themes.getPublishedThemeBySlug(db, 'paper-trail')!.draft === null);

  // =================================================================== versions never change silently
  const p1 = (await themes.getVersionPayload(db, d.id))!;
  ok('extension payload has the full versioned contract', p1.formatVersion === 1 && p1.version === 1 && p1.hostname === 'en.wikipedia.org' && p1.pathScope.mode === 'prefix' && /^[0-9a-f]{64}$/.test(p1.hash) && p1.creator.username === 'alice_art' && !JSON.stringify(p1).includes('example.com'), p1);
  ok('payload hash matches the data', p1.hash === (await versionHash({ hostname: p1.hostname, pathScope: p1.pathScope, css: p1.css })));
  const v2css = 'body{background:#fff8ee}';
  const withDraft = await themes.saveDraftVersion(db, alice.id, d.id, ver({ css: v2css, changeNotes: 'warmer' }));
  ok('editing a published theme creates draft version 2 and leaves version 1 LIVE', withDraft.draft?.version === 2 && withDraft.current?.version === 1 && withDraft.current.css === p1.css, withDraft);
  const stillV1 = (await themes.getVersionPayload(db, d.id))!;
  ok('the extension still receives version 1 while version 2 is a draft', stillV1.version === 1 && stillV1.css === p1.css);
  ok('the public page still shows version 1', themes.getPublishedThemeBySlug(db, 'paper-trail')!.current!.version === 1);
  const again = await themes.saveDraftVersion(db, alice.id, d.id, ver({ css: 'body{background:#fff0e0}' }));
  ok('further edits reuse the same draft version (no version spam)', again.draft?.version === 2 && again.versions.filter((v) => v.state === 'draft').length === 1);
  themes.publish(db, alice.id, d.id, { permissionConfirmed: true });
  const p2 = (await themes.getVersionPayload(db, d.id))!;
  ok('publishing makes version 2 current', p2.version === 2 && p2.versionId !== p1.versionId && p2.css === 'body{background:#fff0e0}');
  const oldStill = await themes.getVersionPayload(db, d.id, p1.versionId);
  ok('version 1 is retired but still fetchable by id for anyone who installed it, unchanged', oldStill?.version === 1 && oldStill.css === p1.css && oldStill.hash === p1.hash, oldStill);
  ok('a version id from a DIFFERENT theme is not served under this theme', (await themes.getVersionPayload(db, d2.id, p1.versionId)) === null);
  await throwsStatus('nothing left to publish', 400, () => themes.publish(db, alice.id, d.id, { permissionConfirmed: true }));

  // =================================================================== tampering
  run(db, "UPDATE theme_versions SET css = 'body{background:red}' WHERE id = ?", p2.versionId);
  await throwsStatus('a row whose CSS was altered in the database fails the integrity check and is never served', 500, () => themes.getVersionPayload(db, d.id));
  run(db, 'UPDATE theme_versions SET css = ? WHERE id = ?', p2.css, p2.versionId);
  ok('...and serving resumes once the data is intact', (await themes.getVersionPayload(db, d.id))?.version === 2);

  // =================================================================== unpublish / republish
  const un = themes.unpublishByOwner(db, alice.id, d.id);
  ok('owner can take a theme offline', un.status === 'unpublished' && un.unpublishedBy === 'owner');
  ok('unpublished themes vanish from the gallery and slug lookup', themes.listPublishedThemes(db).total === 0 && themes.getPublishedThemeBySlug(db, 'paper-trail') === null);
  ok('unpublished themes can no longer be newly installed (current or a specific version)', (await themes.getVersionPayload(db, d.id)) === null && (await themes.getVersionPayload(db, d.id, p1.versionId)) === null);
  ok('the owner can still see it in their own list', themes.listOwnThemes(db, alice.id).some((t) => t.id === d.id && t.status === 'unpublished'));
  const re = themes.republishByOwner(db, alice.id, d.id);
  ok('the owner can bring back a theme they unpublished', re.status === 'published' && (await themes.getVersionPayload(db, d.id))?.version === 2);

  // =================================================================== Fable review L1: republish edge cases
  const l1 = await pubTheme0();
  async function pubTheme0() {
    const t = await themes.createDraft(db, bob.id, meta({ title: 'Edge Case Theme' }), ver());
    themes.addPreview(db, bob.id, t.id, storeMedia(db, bob.id, await processImage(await png(), 'preview')).id, 'after', '');
    return themes.publish(db, bob.id, t.id, { permissionConfirmed: true });
  }
  themes.unpublishByOwner(db, bob.id, l1.id);
  const l1checks = themes.publishChecks(db, bob.id, l1.id, true);
  ok('an owner-unpublished theme with no draft says to use Republish (no crash)', !l1checks.ok && l1checks.problems.some((p) => /Republish/i.test(p)), l1checks);
  await throwsStatus('publish() on it is a clean 400, not a TypeError/500', 400, () => themes.publish(db, bob.id, l1.id, { permissionConfirmed: true }));
  await themes.saveDraftVersion(db, bob.id, l1.id, ver({ css: 'body{color:#222}', changeNotes: 'tweak' }));
  ok('after editing, an unpublished theme CAN publish its new version', themes.publishChecks(db, bob.id, l1.id, true).ok);
  const l1pub = themes.publish(db, bob.id, l1.id, { permissionConfirmed: true });
  ok('...and it goes live as version 2', l1pub.status === 'published' && l1pub.current?.version === 2, l1pub.current);
  themes.deleteTheme(db, bob.id, l1.id);

  // =================================================================== Fable review L2: official accounts can edit their profile
  const studio = accounts.ensureOfficialAccount(db, { email: 'studio@example.com', username: 'whimsyweb-studio', displayName: 'WhimsyWeb Studio', bio: 'Official starter themes.' });
  const studioAs = accounts.updateProfile(db, studio.userId, { username: 'whimsyweb-studio', displayName: 'WhimsyWeb Studio ✨', bio: 'Original themes by the team.' });
  ok('an official account can edit its display name and bio while keeping its handle', studioAs.displayName === 'WhimsyWeb Studio ✨' && studioAs.bio.startsWith('Original') && studioAs.username === 'whimsyweb-studio' && studioAs.official, studioAs);
  const reservedOfficial = accounts.ensureOfficialAccount(db, { email: 'brand@example.com', username: 'whimsyweb', displayName: 'WhimsyWeb', bio: '' });
  const keepsReserved = accounts.updateProfile(db, reservedOfficial.userId, { username: 'whimsyweb', displayName: 'WhimsyWeb Official', bio: 'x' });
  ok('an official account with a RESERVED handle can still edit its profile', keepsReserved.username === 'whimsyweb' && keepsReserved.displayName === 'WhimsyWeb Official', keepsReserved);
  await throwsStatus('...but cannot switch to a different reserved handle', 400, () => accounts.updateProfile(db, reservedOfficial.userId, { username: 'admin', displayName: 'x', bio: '' }));
  await throwsStatus('a regular user still cannot claim a reserved handle', 400, () => accounts.updateProfile(db, bob.id, { username: 'whimsyweb', displayName: 'Bob', bio: '' }));
  await throwsStatus('a regular user cannot claim the official reserved handle even if they type it exactly', 400, () => accounts.updateProfile(db, bob.id, { username: 'official', displayName: 'Bob', bio: '' }));

  // =================================================================== saves / library
  ok('saving a published theme works and counts', (themes.saveTheme(db, bob.id, d.id), themes.isSavedBy(db, bob.id, d.id) && themes.listPublishedThemes(db).items[0].saveCount === 1));
  themes.saveTheme(db, bob.id, d.id);
  ok('saving twice is harmless (no double count)', themes.listPublishedThemes(db).items[0].saveCount === 1);
  await throwsStatus('cannot save a draft', 404, () => themes.saveTheme(db, bob.id, d2.id));
  ok('saves are private per user', !themes.isSavedBy(db, alice.id, d.id) && themes.listSaved(db, alice.id).length === 0 && themes.listSaved(db, bob.id).length === 1);
  themes.unsaveTheme(db, bob.id, d.id);
  ok('removing from the collection leaves the theme itself intact', !themes.isSavedBy(db, bob.id, d.id) && themes.getPublishedThemeBySlug(db, 'paper-trail') !== null);
  themes.saveTheme(db, bob.id, d.id);

  // =================================================================== moderation
  await throwsStatus('anonymous reports of unpublished/draft themes are 404', 404, () => moderation.createReport(db, null, d2.id, 'other', ''));
  await throwsStatus('invalid report reason is rejected', 400, () => moderation.createReport(db, bob.id, d.id, 'because', ''));
  const r1 = moderation.createReport(db, bob.id, d.id, 'harmful', 'It hides the nav');
  const r1b = moderation.createReport(db, bob.id, d.id, 'harmful', 'again');
  ok('a repeat open report by the same user is idempotent', r1.id === r1b.id && r1b.duplicate);
  const r2 = moderation.createReport(db, null, d.id, 'broken', '');
  ok('anonymous reports are allowed', !!r2.id && !r2.duplicate);
  await throwsStatus('regular users cannot list reports', 403, () => moderation.listReports(db, alice.id));
  await throwsStatus('anonymous cannot list reports', 401, () => moderation.listReports(db, null));
  await throwsStatus('regular users cannot resolve reports', 403, () => moderation.resolveReport(db, alice.id, r1.id, 'unpublish', ''));
  await throwsStatus('regular users cannot read the moderation log', 403, () => moderation.listModerationLog(db, bob.id));
  const open = moderation.listReports(db, mod.id);
  ok('moderators see open reports with usernames and no emails', open.length === 2 && open[0].ownerUsername === 'alice_art' && !JSON.stringify(open).includes('@example.com'), open);
  moderation.resolveReport(db, mod.id, r1.id, 'unpublish', 'Hides navigation');
  ok('actioning a report unpublishes the theme by moderation and closes every open report on it', themes.getThemeForOwner(db, alice.id, d.id).status === 'unpublished' && themes.getThemeForOwner(db, alice.id, d.id).unpublishedBy === 'moderation' && moderation.listReports(db, mod.id).length === 0, moderation.listReports(db, mod.id, 'all').map((r) => r.status));
  ok('the action is written to the audit log', moderation.listModerationLog(db, mod.id).some((l) => l.action === 'unpublish' && l.themeTitle === 'Paper Trail' && l.note === 'Hides navigation' && l.actor === accounts.getProfile(db, mod.id)!.username));
  ok('a moderated theme can no longer be installed', (await themes.getVersionPayload(db, d.id)) === null);
  await throwsStatus('the owner cannot republish a moderated theme', 403, () => themes.republishByOwner(db, alice.id, d.id));
  await throwsStatus('...and publish checks say so', 400, () => themes.publish(db, alice.id, d.id, { permissionConfirmed: true }));
  await throwsStatus('handling an already-handled report is a 409', 409, () => moderation.resolveReport(db, mod.id, r2.id, 'dismiss', ''));
  ok('the saver still sees it in their library, now marked unavailable', themes.listSaved(db, bob.id).some((t) => t.id === d.id && t.status === 'unpublished'));
  // a fresh theme: dismiss path
  const d3 = await themes.createDraft(db, alice.id, meta({ title: 'Quiet Focus', hostname: 'en.wikipedia.org' }), ver());
  themes.addPreview(db, alice.id, d3.id, ownMedia.id, 'after', '');
  themes.publish(db, alice.id, d3.id, { permissionConfirmed: true });
  const r3 = moderation.createReport(db, bob.id, d3.id, 'other', 'meh');
  moderation.resolveReport(db, mod.id, r3.id, 'dismiss', 'Looks fine');
  ok('dismissing leaves the theme published and logs it', themes.getPublishedThemeBySlug(db, d3.slug) !== null && moderation.listModerationLog(db, mod.id).some((l) => l.action === 'dismiss'));
  moderation.moderatorUnpublish(db, mod.id, d3.id, 'direct action');
  ok('a moderator can unpublish directly (audited)', themes.getPublishedThemeBySlug(db, d3.slug) === null && moderation.listModerationLog(db, mod.id)[0].action === 'unpublish');
  await throwsStatus('regular users cannot moderator-unpublish', 403, () => moderation.moderatorUnpublish(db, bob.id, d3.id, ''));

  // =================================================================== search / filters / pagination
  const pubTheme = async (user: typeof alice, over: Record<string, unknown>, css = GOOD_CSS) => {
    const t = await themes.createDraft(db, user.id, meta(over), ver({ css }));
    themes.addPreview(db, user.id, t.id, storeMedia(db, user.id, await processImage(await png(), 'preview')).id, 'after', '');
    return themes.publish(db, user.id, t.id, { permissionConfirmed: true });
  };
  const hn = await pubTheme(bob, { title: 'Terminal Green', hostname: 'news.ycombinator.com', appearance: 'dark', tags: ['terminal', 'green'], description: 'Restrained terminal look.' });
  const hn2 = await pubTheme(bob, { title: 'Sunday Edition', hostname: 'news.ycombinator.com', appearance: 'light', tags: ['newspaper'], description: 'Newspaper-like.' });
  const gh = await pubTheme(bob, { title: '100% Contrast_Mode', hostname: 'github.com', appearance: 'mixed', tags: ['contrast'], description: 'Clear borders' });
  const names = (o: themes.ListOptions) => themes.listPublishedThemes(db, o).items.map((t) => t.title).sort();
  ok('search matches titles', names({ q: 'terminal' }).join() === 'Terminal Green');
  ok('search matches descriptions', names({ q: 'newspaper-like' }).join() === 'Sunday Edition');
  ok('search matches tags', names({ q: 'contrast' }).includes('100% Contrast_Mode'));
  ok('search matches the friendly site name ("hacker")', names({ q: 'hacker' }).join() === 'Sunday Edition,Terminal Green', names({ q: 'hacker' }));
  ok('search matches the hostname', names({ q: 'github' }).join() === '100% Contrast_Mode');
  ok('search matches the creator name', names({ q: 'bo' }).length >= 3);
  ok('a lone "%" is escaped and does NOT match everything', names({ q: '%' }).join() === '100% Contrast_Mode', names({ q: '%' }));
  ok('a lone "_" is escaped too', names({ q: '_' }).join() === '100% Contrast_Mode', names({ q: '_' }));
  ok('a SQL-ish query is just text', names({ q: "'; DROP TABLE themes;--" }).length === 0 && themes.listPublishedThemes(db).total >= 3);
  ok('filter by website', names({ hostname: 'news.ycombinator.com' }).join() === 'Sunday Edition,Terminal Green');
  ok('filter by appearance', names({ appearance: 'dark' }).join() === 'Terminal Green' && names({ appearance: 'mixed' }).join() === '100% Contrast_Mode');
  ok('filter by tag', names({ tag: 'green' }).join() === 'Terminal Green');
  ok('combined filters intersect', names({ hostname: 'news.ycombinator.com', appearance: 'light' }).join() === 'Sunday Edition');
  themes.saveTheme(db, alice.id, hn.id);
  themes.saveTheme(db, mod.id, hn.id);
  themes.saveTheme(db, bob.id, hn.id);
  themes.saveTheme(db, alice.id, hn2.id);
  const bySaved = themes.listPublishedThemes(db, { sort: 'saved' }).items;
  ok('"most saved" uses real counts (3, then 1)', bySaved[0].title === 'Terminal Green' && bySaved[0].saveCount === 3 && bySaved[1].title === 'Sunday Edition' && bySaved[1].saveCount === 1, bySaved.map((t) => [t.title, t.saveCount]));
  ok('"recently added" is newest first', themes.listPublishedThemes(db, { sort: 'recent', pageSize: 100 }).items[0].publishedAt! >= themes.listPublishedThemes(db, { sort: 'recent', pageSize: 100 }).items.at(-1)!.publishedAt!);
  for (let i = 0; i < 14; i++) await pubTheme(bob, { title: `Filler ${i}`, hostname: 'github.com' });
  const pg1 = themes.listPublishedThemes(db, { pageSize: 5, page: 1 });
  const pg2 = themes.listPublishedThemes(db, { pageSize: 5, page: 2 });
  ok('pagination reports total and pages', pg1.total >= 17 && pg1.pages === Math.ceil(pg1.total / 5) && pg1.items.length === 5 && pg2.items.length === 5, [pg1.total, pg1.pages]);
  ok('pages do not overlap', pg1.items.every((a) => !pg2.items.some((b) => b.id === a.id)));
  ok('out-of-range page is empty but valid', themes.listPublishedThemes(db, { pageSize: 5, page: 999 }).items.length === 0);
  ok('absurd page size is clamped', themes.listPublishedThemes(db, { pageSize: 100000 }).pageSize === 48 && themes.listPublishedThemes(db, { pageSize: -5 }).pageSize === 1);
  const facets = themes.galleryFacets(db);
  ok('facets only list websites/tags that have published themes (and never the moderated one\'s tags)', facets.hostnames.every((h) => h.count > 0) && facets.tags.find((t) => t.tag === 'paper')?.count === 14 /* the 14 fillers; the moderated theme is not counted */ && facets.tags.some((t) => t.tag === 'terminal'), facets);
  ok('a creator page lists only their PUBLISHED themes', themes.listThemesByCreator(db, 'bobby').every((t) => t.status === 'published') && themes.listThemesByCreator(db, 'alice_art').length === 0);
  ok('featured is real data (most saved first)', themes.listFeatured(db, 3)[0].title === 'Terminal Green');
  ok('previews appear on cards', !!themes.listPublishedThemes(db, { q: 'terminal' }).items[0].previewMediaId);

  // =================================================================== delete (cascade)
  const delFiles = themes.deleteTheme(db, bob.id, gh.id);
  ok('deleting a theme removes it and its previews, returning files to clean up', themes.getPublishedThemeBySlug(db, gh.slug) === null && delFiles.length === 1 && !get(db, 'SELECT 1 AS x FROM theme_previews WHERE theme_id = ?', gh.id));
  ok('a theme\'s saves disappear with it', !get(db, 'SELECT 1 AS x FROM saved_themes WHERE theme_id = ?', gh.id));

  // =================================================================== rate limiting
  const t0 = 1_000_000_000_000;
  ok('rate limit allows up to the limit then blocks', [1, 2, 3].every((n) => checkRateLimit(db, 'x', 3, 60_000, t0 + n).ok) && !checkRateLimit(db, 'x', 3, 60_000, t0 + 10).ok);
  ok('the block reports when to retry', checkRateLimit(db, 'x', 3, 60_000, t0 + 10).retryAfterMs > 0);
  ok('limits reset in the next window', checkRateLimit(db, 'x', 3, 60_000, t0 + 61_000).ok);
  ok('limits are per bucket', checkRateLimit(db, 'y', 3, 60_000, t0 + 20).ok);
  await throwsStatus('enforceRateLimit throws 429', 429, () => { for (let i = 0; i < 5; i++) enforceRateLimit(db, 'z', 2, 3_600_000); });

  // =================================================================== uploads
  ok('sniffImage accepts real PNG/JPEG/WebP', sniffImage(await png()) === 'png' && sniffImage(await sharp(await png()).jpeg().toBuffer()) === 'jpeg' && sniffImage(await sharp(await png()).webp().toBuffer()) === 'webp');
  ok('sniffImage rejects SVG, GIF, HTML, PDF, EXE and empty data', [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), Buffer.from('GIF89a....'), Buffer.from('<!doctype html><script>1</script>'), Buffer.from('%PDF-1.7'), Buffer.from('MZ\x90\x00'), Buffer.alloc(0)].every((b) => sniffImage(b) === null));
  await throwsStatus('an SVG upload is refused (415)', 415, () => processImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'preview'));
  await throwsStatus('a file renamed to look like an image but containing HTML is refused', 415, () => processImage(Buffer.from('<html><script>alert(1)</script></html>'), 'preview'));
  await throwsStatus('an empty upload is refused', 400, () => processImage(Buffer.alloc(0), 'preview'));
  await throwsStatus('an oversized upload is refused (413)', 413, () => processImage(Buffer.alloc(7 * 1024 * 1024, 1), 'preview'));
  await throwsStatus('a tiny preview is refused', 400, async () => processImage(await png(100, 60), 'preview'));
  await throwsStatus('PNG header with garbage after it is refused cleanly (400)', 400, () => processImage(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('garbage garbage garbage')]), 'preview'));
  const withExif = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#336699' } }).jpeg().withExif({ IFD0: { Copyright: 'SECRET-LOCATION-TAG', Artist: 'Jane Private' } }).toBuffer();
  ok('the test image really carries metadata', withExif.toString('latin1').includes('SECRET-LOCATION-TAG'));
  const clean = await processImage(withExif, 'preview');
  const cleanMeta = await sharp(clean.data).metadata();
  ok('re-encoding strips EXIF and the private strings are gone from the bytes', !cleanMeta.exif && !clean.data.toString('latin1').includes('SECRET-LOCATION-TAG') && !clean.data.toString('latin1').includes('Jane Private'));
  ok('output is always WebP', clean.mime === 'image/webp' && sniffImage(clean.data) === 'webp' && cleanMeta.format === 'webp');
  const big = await processImage(await png(4000, 3000), 'preview');
  ok('large previews are scaled down (max edge 1600)', Math.max(big.width, big.height) === 1600 && big.width === 1600, big);
  const av = await processImage(await png(900, 400), 'avatar');
  ok('avatars become 256x256', av.width === 256 && av.height === 256);
  const stored = storeMedia(db, alice.id, clean);
  ok('stored media can be read back', readMedia(db, stored.id)?.mime === 'image/webp' && readMedia(db, stored.id)!.data.equals(clean.data));
  ok('media ids that are not UUIDs (path traversal) read as nothing', readMedia(db, '../../etc/passwd') === null && readMedia(db, '..%2f..%2fsecret') === null && readMedia(db, 'x') === null);
  ok('unknown media id reads as nothing', readMedia(db, crypto.randomUUID()) === null);
  await throwsStatus('requireOwnMedia rejects someone else\'s image', 403, () => requireOwnMedia(db, bob.id, stored.id));
  accounts.setAvatar(db, alice.id, stored.id);
  ok('a user can set their own avatar', accounts.getProfile(db, alice.id)!.avatarId === stored.id);
  await throwsStatus('a user cannot use another user\'s image as an avatar', 403, () => accounts.setAvatar(db, bob.id, stored.id));

  // =================================================================== account deletion
  const aliceThemes = themes.listOwnThemes(db, alice.id).length;
  const aliceFiles = all<{ file: string }>(db, 'SELECT file FROM media WHERE owner_id = ?', alice.id).map((m) => m.file);
  ok('alice has content before deletion', aliceThemes >= 3 && aliceFiles.length >= 2 && aliceFiles.every((f) => existsSync(path.join(process.env.DATA_DIR!, 'uploads', f))));
  const bobSavedBefore = themes.listSaved(db, bob.id).length;
  const files = accounts.deleteAccount(db, alice.id);
  deleteMediaFiles(files);
  ok('deleting an account removes the user, profile and ALL their themes and versions', !accounts.getUserById(db, alice.id) && !accounts.getProfile(db, alice.id) && themes.listOwnThemes(db, alice.id).length === 0 && !get(db, 'SELECT 1 AS x FROM theme_versions WHERE theme_id = ?', d.id));
  ok('their uploaded files are deleted from disk', files.length === aliceFiles.length && files.every((f) => !existsSync(path.join(process.env.DATA_DIR!, 'uploads', f))));
  ok('other users\' data is untouched', accounts.getProfile(db, bob.id)?.username === 'bobby' && themes.listOwnThemes(db, bob.id).length === 16);
  ok('saves of the deleted creator\'s themes disappear from other libraries', themes.listSaved(db, bob.id).length < bobSavedBefore || bobSavedBefore === 0, [bobSavedBefore, themes.listSaved(db, bob.id).length]);
  ok('the moderation log is kept, with the actor intact', moderation.listModerationLog(db, mod.id).length >= 3);
  ok('reports about deleted themes are gone, not dangling', all<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM reports r LEFT JOIN themes t ON t.id = r.theme_id WHERE t.id IS NULL')[0].n === 0);
  const orphanCheck = all<{ n: number }>(db, 'PRAGMA foreign_key_check');
  ok('the database has no foreign-key violations after deletion', orphanCheck.length === 0, orphanCheck);
  await throwsStatus('a deleted user is no longer authorized to do anything', 401, () => accounts.requireUser(db, alice.id));

  // =================================================================== helpers
  ok('normalizeTags lowercases, dedupes, strips junk and caps the count', normalizeTags(' Warm, WARM,paper!!,  a  b ,,'+ Array.from({ length: 20 }, (_, i) => `t${i}`).join(',')).length === 8 && normalizeTags('Warm, WARM')[0] === 'warm' && normalizeTags('Warm, WARM').length === 1);
  ok('slugify handles accents, symbols and empties', slugify('Crème Brûlée!!') === 'creme-brulee' && slugify('!!!') === 'theme' && slugify('a'.repeat(100)).length === 48);
  ok('compareVersions orders dotted versions', compareVersions('0.2.0', '0.10.0') < 0 && compareVersions('1.0', '1.0.0') === 0 && compareVersions('2.0.0', '1.9.9') > 0);

  // migrations are idempotent and tracked
  const again2 = openDb(':memory:');
  ok('migrations record themselves', get<{ n: number }>(again2, 'SELECT COUNT(*) AS n FROM schema_migrations')!.n >= 1);
  const { migrate } = await import('../web/src/lib/db');
  migrate(again2);
  ok('running migrations twice is a no-op', get<{ n: number }>(again2, 'SELECT COUNT(*) AS n FROM schema_migrations')!.n === get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM schema_migrations')!.n);
  void tx;

  console.log(fails ? `${fails} FAILED` : 'ALL OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('TEST CRASHED', e);
  process.exit(2);
});
