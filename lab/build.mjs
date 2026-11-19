// Builds the Whimsy Lab test extension into dist-lab/ (load that folder as an unpacked extension).
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const OUT = 'dist-lab';
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await cp('lab/manifest.json', `${OUT}/manifest.json`);
await cp('lab/panel.html', `${OUT}/panel.html`);
await cp('lab/panel.css', `${OUT}/panel.css`);
await cp('lab/icons', `${OUT}/icons`, { recursive: true });
await build({
  entryPoints: { panel: 'lab/src/panel.ts', content: 'lab/src/content.ts', background: 'lab/src/background.ts' },
  outdir: OUT,
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', __WW_SITE_URL__: '"http://localhost:3000"', __WW_E2E__: 'false' },
  logLevel: 'info',
});
