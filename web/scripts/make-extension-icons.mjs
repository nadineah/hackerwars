// Writes the extension's toolbar/store icons as the same "Ink" rounded square used on the website (transparent outside the
// corners). Run from web/:  node scripts/make-extension-icons.mjs
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';

const SRC = '../assets/whimsyweb-logo.png';
const CROP = 930; // same crop as make-logo.mjs so the W matches the website mark
const meta = await sharp(SRC).metadata();
const left = Math.round((meta.width - CROP) / 2) - 2;
const top = Math.round((meta.height - CROP) / 2) + 2;

async function ink(size, radiusRatio = 0.225) {
  const base = await sharp(SRC).extract({ left, top, width: CROP, height: CROP }).resize(size, size).toBuffer();
  const r = Math.round(size * radiusRatio);
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="#fff"/></svg>`);
  return sharp(base).ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png({ compressionLevel: 9 }).toBuffer();
}

for (const size of [16, 32, 48, 128]) {
  const file = `../public/icons/icon${size}.png`;
  writeFileSync(file, await ink(size));
  const check = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => check.data[(y * check.info.width + x) * check.info.channels + 3];
  console.log(file, 'corner alpha', px(0, 0), 'centre alpha', px(size >> 1, size >> 1));
}
