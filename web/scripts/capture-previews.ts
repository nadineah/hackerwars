// Captures real before/after screenshots of each seed theme on its target website, using the SAME validated CSS
// that gets published. Needs Playwright (not a dependency of the site): `npm i -D playwright && npx playwright install chromium`.
// Run: npm run seed:capture
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { validateCommunityCss } from '../../theme-core/src';

const dir = path.resolve('seed');
const themes = JSON.parse(readFileSync(path.join(dir, 'themes.json'), 'utf8')) as { file: string; title: string; targetUrl: string }[];

(async () => {
  const { chromium } = require('playwright');
  mkdirSync(path.join(dir, 'previews'), { recursive: true });
  const browser = await chromium.launch();
  let failed = 0;
  const only = process.argv[2];
  for (const t of themes) {
    if (only && !t.file.includes(only)) continue;
    const slug = t.file.replace(/\.css$/, '');
    const report = validateCommunityCss(readFileSync(path.join(dir, 'themes', t.file), 'utf8'));
    if (!report.ok) {
      console.log('INVALID', slug, report.errors);
      failed++;
      continue;
    }
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'light' });
    await page.goto(t.targetUrl, { waitUntil: 'networkidle', timeout: 45_000 });
    // Wikipedia sometimes shows a fundraising banner to a random session. It is not part of the theme, so it is hidden
    // in BOTH screenshots to keep the comparison honest.
    await page.addStyleTag({ content: '#centralNotice, .frb-inline, .cn-fundraising, [id^="frbanner"], .mw-banner-container { display: none !important; }' });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(dir, 'previews', `${slug}-before.png`) });
    await page.addStyleTag({ content: report.css });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(dir, 'previews', `${slug}-after.png`) });
    await page.close();
    console.log('captured', slug);
  }
  await browser.close();
  writeFileSync(path.join(dir, 'previews', '.captured-at'), new Date().toISOString());
  process.exit(failed ? 1 : 0);
})();
