// Bundles and runs each tests/*.test.ts(x) in Node. No test framework: each file prints ok/FAIL lines
// and exits non-zero on failure. Usage: npm test [-- name-filter]
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const filter = process.argv[2];
const dir = 'tests';
const out = '.test-build';
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const files = (await readdir(dir)).filter((f) => /\.test\.tsx?$/.test(f) && (!filter || f.includes(filter)));
let failed = 0;
for (const f of files) {
  const outfile = path.join(out, f.replace(/\.tsx?$/, '.cjs'));
  await build({
    entryPoints: [path.join(dir, f)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external: ['jsdom', 'sharp'],
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.css': 'empty' },
    logLevel: 'error',
  });
  // The website's dependencies (sharp) live in web/node_modules; expose them to the bundled test.
  const r = spawnSync(process.execPath, [outfile], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, NODE_PATH: path.resolve('web/node_modules'), NODE_NO_WARNINGS: '1' },
  });
  const lines = (r.stdout || '').trim().split('\n');
  const checks = lines.filter((l) => /^(ok|FAIL)\b/.test(l)).length;
  const bad = lines.filter((l) => l.startsWith('FAIL'));
  const status = r.status === 0 ? 'PASS' : 'FAIL';
  console.log(`${status}  ${f}  (${checks} checks)`);
  if (r.status !== 0) {
    failed++;
    bad.forEach((l) => console.log('   ' + l));
    if (r.stderr) console.log(r.stderr.split('\n').slice(0, 6).join('\n'));
  }
}
await rm(out, { recursive: true, force: true });
console.log(failed ? `\n${failed} test file(s) failed` : `\nAll ${files.length} test files passed`);
process.exit(failed ? 1 : 0);
