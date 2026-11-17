import { build, context } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

// The community website this build talks to. Set WHIMSYWEB_SITE_URL for production (https only); extra allowed
// origins can be listed in WHIMSYWEB_SITE_ORIGINS (comma separated). Defaults suit local development.
const SITE_URL = (process.env.WHIMSYWEB_SITE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const ORIGINS = [
  ...new Set([
    new URL(SITE_URL).origin,
    ...(process.env.WHIMSYWEB_SITE_ORIGINS || '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean)
      .map((o) => new URL(o).origin),
  ]),
];

const options = {
  entryPoints: {
    background: 'src/background/index.ts',
    content: 'src/content/index.ts',
    sidepanel: 'src/sidepanel/main.tsx',
    confirm: 'src/community/confirm.ts',
  },
  outdir: 'dist',
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  jsx: 'automatic',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"', __WW_SITE_URL__: JSON.stringify(SITE_URL) },
  logLevel: 'info',
};

async function copyStatic() {
  await mkdir('dist', { recursive: true });
  await cp('public', 'dist', { recursive: true });
  // Only exact https origins (or localhost, for development) may message the extension.
  for (const o of ORIGINS) {
    const u = new URL(o);
    if (u.protocol !== 'https:' && u.hostname !== 'localhost') throw new Error('Refusing non-https site origin ' + o);
  }
  const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
  manifest.externally_connectable = { matches: ORIGINS.map((o) => o + '/*') };
  await writeFile('dist/manifest.json', JSON.stringify(manifest, null, 2));
}

if (watch) {
  await copyStatic();
  const ctx = await context(options);
  await ctx.watch();
  console.log('Watching… reload the extension at chrome://extensions after changes to manifest/background.');
} else {
  await rm('dist', { recursive: true, force: true });
  await copyStatic();
  await build(options);
}
