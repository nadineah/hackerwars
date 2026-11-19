// Draws the Whimsy Lab icon: a soft pink gradient rounded square with a white lab flask. Run: node lab/make-icons.cjs
const sharp = require('../web/node_modules/sharp');
const svg = (n) => `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="g" x1="0.1" y1="0" x2="0.9" y2="1">
      <stop offset="0" stop-color="#ffd9ea"/><stop offset="0.55" stop-color="#ffaed0"/><stop offset="1" stop-color="#ff86b8"/>
    </linearGradient>
    <radialGradient id="shine" cx="0.3" cy="0.2" r="0.7"><stop offset="0" stop-color="#fff" stop-opacity="0.55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="128" height="128" rx="30" fill="url(#g)"/>
  <rect width="128" height="128" rx="30" fill="url(#shine)"/>
  <g fill="none" stroke="#ffffff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M50 24h28"/>
    <path d="M56 24v30L36 92a9 9 0 0 0 8 13h40a9 9 0 0 0 8-13L72 54V24"/>
    <path d="M45 78h38"/>
  </g>
  <circle cx="64" cy="92" r="4.5" fill="#fff"/><circle cx="76" cy="84" r="3" fill="#fff" opacity="0.85"/>
</svg>`;
(async () => {
  for (const n of [16, 32, 48, 128]) await sharp(Buffer.from(svg(n))).png().toFile(`lab/icons/icon${n}.png`);
  console.log('icons written');
})();
