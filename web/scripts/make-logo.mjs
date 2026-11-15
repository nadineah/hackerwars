// One-off: turns the supplied logo (a black square with a white W) into the "Ink" mark: the SAME artwork
// on a black rounded square with a transparent outside. Run: node scripts/make-logo.mjs
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

const SRC = '../assets/whimsyweb-logo.png';
const CROP = 930; // trims the black margin so the W reads at small sizes (same crop as the extension icons)
const meta = await sharp(SRC).metadata();
const left = Math.round((meta.width - CROP) / 2) - 2;
const top = Math.round((meta.height - CROP) / 2) + 2;

async function ink(size, radiusRatio = 0.225) {
  const base = await sharp(SRC).extract({ left, top, width: CROP, height: CROP }).resize(size, size).toBuffer();
  const r = Math.round(size * radiusRatio);
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="#fff"/></svg>`);
  return sharp(base).ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png({ compressionLevel: 9 }).toBuffer();
}

mkdirSync('public', { recursive: true });
mkdirSync('src/app', { recursive: true });
const out = { 'public/logo.png': 512, 'public/logo-64.png': 64, 'src/app/icon.png': 192, 'src/app/apple-icon.png': 180 };
import { writeFileSync } from 'node:fs';
for (const [file, size] of Object.entries(out)) {
  writeFileSync(file, await ink(size));
  console.log(file, size);
}
// Verify transparency: the corner pixel must be fully transparent, the centre opaque.
const check = await sharp('public/logo.png').raw().toBuffer({ resolveWithObject: true });
const px = (x, y) => check.data[(y * check.info.width + x) * check.info.channels + 3];
console.log('corner alpha', px(0, 0), 'centre alpha', px(256, 256), 'channels', check.info.channels);
