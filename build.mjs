import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: {
    background: 'src/background/index.ts',
    content: 'src/content/index.ts',
    sidepanel: 'src/sidepanel/main.tsx',
  },
  outdir: 'dist',
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  jsx: 'automatic',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
  logLevel: 'info',
};

async function copyStatic() {
  await mkdir('dist', { recursive: true });
  await cp('public', 'dist', { recursive: true });
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
