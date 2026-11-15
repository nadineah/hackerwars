// Bundles a TypeScript script from scripts/ with esbuild and runs it with Node. Usage: node scripts/run.mjs <name> [args...]
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const [name, ...args] = process.argv.slice(2);
if (!name) {
  console.error('Usage: node scripts/run.mjs <script-name> [args]');
  process.exit(2);
}
const out = path.resolve('.build', `${name}.cjs`);
await build({
  entryPoints: [path.resolve('scripts', `${name}.ts`)],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['sharp', 'playwright'],
  logLevel: 'error',
});
const r = spawnSync(process.execPath, ['--no-warnings', out, ...args], { stdio: 'inherit' });
process.exit(r.status ?? 1);
