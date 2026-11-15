// Publishes the starter themes under the "WhimsyWeb Studio" account. Repeatable: running it again creates no
// duplicates; a theme whose CSS changed gets a NEW version (older installs are untouched).
// Run: npm run db:seed        (screenshots come from `npm run seed:capture`, already committed in seed/previews)
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { processImage, storeMedia } from '../src/lib/media';
import { get, openDb } from '../src/lib/db';
import { ensureOfficialAccount } from '../src/lib/repo/accounts';
import * as themes from '../src/lib/repo/themes';
import { validateCommunityCss, versionHash } from '../../theme-core/src';

interface Seed {
  file: string;
  title: string;
  hostname: string;
  pathScope: { mode: 'all' } | { mode: 'prefix' | 'exact'; paths: string[] };
  description: string;
  tags: string[];
  appearance: 'light' | 'dark' | 'mixed';
  license: string;
  compatNotes: string;
  previewAlt: string;
}

const root = path.resolve('seed');
const seeds = JSON.parse(readFileSync(path.join(root, 'themes.json'), 'utf8')) as Seed[];

(async () => {
  const db = openDb();
  const studio = ensureOfficialAccount(db, {
    email: process.env.STUDIO_EMAIL || 'studio@whimsyweb.invalid',
    username: 'whimsyweb-studio',
    displayName: 'WhimsyWeb Studio',
    bio: 'The WhimsyWeb team. Starter themes, tested on the live sites they target.',
  });
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const s of seeds) {
    const slugBase = s.file.replace(/\.css$/, '');
    const css = readFileSync(path.join(root, 'themes', s.file), 'utf8');
    const report = validateCommunityCss(css);
    if (!report.ok) throw new Error(`${s.title}: CSS is invalid: ${report.errors.map((e) => e.message).join('; ')}`);

    const existing = get<{ id: string; slug: string }>(db, 'SELECT id, slug FROM themes WHERE owner_id = ? AND title = ?', studio.userId, s.title);
    const input = { css, pathScope: s.pathScope, changeNotes: 'Initial release.' };
    let id: string;
    if (!existing) {
      const t = await themes.createDraft(db, studio.userId, { title: s.title, description: s.description, hostname: s.hostname, tags: s.tags, appearance: s.appearance, license: s.license, compatNotes: s.compatNotes }, input);
      id = t.id;
      created++;
    } else {
      id = existing.id;
      const t = themes.getThemeForOwner(db, studio.userId, id);
      const latest = t.draft ?? t.current;
      const newHash = await versionHash({ hostname: s.hostname, pathScope: s.pathScope, css: report.css });
      themes.updateMeta(db, studio.userId, id, { title: s.title, description: s.description, tags: s.tags, appearance: s.appearance, license: s.license, compatNotes: s.compatNotes });
      if (latest?.hash === newHash && t.status === 'published') {
        unchanged++;
        continue;
      }
      await themes.saveDraftVersion(db, studio.userId, id, { ...input, changeNotes: 'Updated style sheet.' });
      updated++;
    }

    // Screenshots: only added when the theme has none, so re-running never duplicates them.
    const have = themes.getThemeForOwner(db, studio.userId, id).previews.length;
    if (have === 0) {
      for (const role of ['before', 'after'] as const) {
        const file = path.join(root, 'previews', `${slugBase}-${role}.png`);
        if (!existsSync(file)) throw new Error(`Missing preview ${file}. Run: npm run seed:capture`);
        const { id: mediaId } = storeMedia(db, studio.userId, await processImage(readFileSync(file), 'preview'));
        themes.addPreview(db, studio.userId, id, mediaId, role, `${s.previewAlt}${role === 'before' ? ' without the theme' : ` with the ${s.title} theme`}`);
      }
    }
    themes.publish(db, studio.userId, id, { permissionConfirmed: true });
  }
  console.log(`Seed complete: ${created} created, ${updated} updated, ${unchanged} unchanged.`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
