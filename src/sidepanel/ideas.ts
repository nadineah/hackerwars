/**
 * Example prompts shown on an empty chat. A hand-written pool (no AI involved): a few are picked at random each time
 * the chat is opened or revisited, never repeating what was just shown.
 */
export const IDEAS: readonly string[] = [
  // storybook and nature
  'An enchanted forest with elegant serif type and botanical decorations',
  'A dreamy fairy-tale scrapbook with washi tape and handwritten fonts',
  'A moonlit lily pond with tiny frogs and gentle ripples',
  'A cozy mushroom cottage with warm lantern light and mossy greens',
  'Wildflower meadow: soft greens, pressed-flower borders, hand-lettered headings',
  'Underwater world with deep teals, drifting bubbles and glowing jellyfish',
  'A snowy cabin evening with frosted glass cards and warm window light',
  'Autumn leaves: rust, mustard and cream with a cozy sweater texture',
  'A tropical island getaway with sunset gradients and palm shadows',
  'A secret garden with ivy borders and old-world serif headings',
  'Cherry blossom spring with soft pinks and floating petals',
  'A quiet desert at dusk: terracotta, sand and a purple sky',
  // retro and techy
  'Y2K cyber-pop with glitter gradients and chunky bubble buttons',
  'A 90s arcade: neon on black, pixel fonts and chunky borders',
  'Terminal green on black like an old hacker console',
  'Vaporwave sunset with pink and teal grids and chrome type',
  'A retro-futuristic spaceship dashboard with glowing cyan panels',
  'Windows 95 nostalgia: beveled grey buttons and a teal desktop',
  'Gameboy-style four-shade green with pixel borders',
  'An 80s synthwave night drive with magenta and electric blue',
  'A blueprint: white line work on deep blue with drafting-paper grid',
  'Cassette-tape mixtape look with warm plastic colors and handwriting',
  // elegant and calm
  'Dark academia: candlelit library, parchment, gold accents',
  'Minimal and calm: lots of whitespace, soft grey, one gentle accent color',
  'A luxurious art deco look with black, gold and geometric lines',
  'Quiet Japanese paper look: off-white, ink black and a single red seal',
  'A Scandinavian living room: pale wood, oatmeal and soft shadows',
  'Elegant newspaper editorial with classic serif type and thin rules',
  'A museum gallery: bright white walls, thin frames and caption-style text',
  'Soft pastel gradients with rounded cards and friendly type',
  'Paper notebook with ruled lines, margin doodles and ink-blue text',
  'A warm coffee shop menu with chalkboard textures and cream paper',
  // bold and playful
  'Neo-brutalist: thick black outlines, flat bright colors, hard shadows',
  'A comic book page with halftone dots, speech-bubble buttons and bold type',
  'Candy shop colors with glossy buttons and bouncy rounded shapes',
  'Bubblegum pink everything, with sparkles on hover',
  'A kid’s sticker book with bright colors and wobbly outlines',
  'A circus tent in red and cream stripes with fancy poster type',
  'Chunky clay-style 3D look with soft rounded shapes and pastel colors',
  'A superhero poster look with bold primaries and dramatic angles',
  'Rainbow gradient headings on a clean white page',
  'A cartoon sky with puffy clouds behind the content',
  // moods and themes
  'Make it feel like a rainy night in a quiet city',
  'A cozy winter holiday look with twinkle lights and evergreen accents',
  'Halloween: spooky purples, candlelight orange and cobweb corners',
  'A midnight observatory with deep navy, tiny stars and silver type',
  'Make it feel like a sunny picnic with gingham and warm yellows',
  'A mystical tarot-card look with ornate gold borders and deep purples',
  'Pirate map: aged parchment, ink lines and a treasure-chest accent',
  'Medieval illuminated manuscript with ornate first letters and gold leaf',
  'A cozy bookshop with wood tones, warm lamps and serif type',
  'A space explorer’s log with starfield backdrop and glowing instrument panels',
  'Steampunk brass, leather and gears with Victorian lettering',
  'A film noir look: high-contrast black and white with a single red accent',
  // practical
  'Make the text larger and easier to read with higher contrast',
  'A distraction-free reading mode with a narrow column and warm paper color',
  'Declutter this page: hide the extras and keep the main content',
  'A gentle dark mode that is easy on the eyes at night',
  'Calmer colors with fewer bright banners and less visual noise',
  'Bigger buttons and clearer spacing so everything is easy to tap',
  'A sepia, old-book reading theme with generous line spacing',
  'High-contrast black and yellow for maximum legibility',
  'Tidy up the layout: consistent spacing, aligned cards and a clean grid',
  'A focused work look: muted tones, small accents and no animations',
  // delightful details
  'Frogs everywhere. Magical and whimsical',
  'Add little stars that twinkle around the headings',
  'Make every button look like a candy',
  'Turn the headings into hand-painted signs',
  'A glassy frosted look with blurred backgrounds and soft glow',
  'Give the cards a polaroid-photo look with slight tilts',
  'A scrapbook of sticky notes, tape and doodles',
  'Make it look like a cozy handwritten letter',
  'Cute pastel kawaii look with tiny hearts and soft clouds',
  'Soft neon glow on dark, like a late-night diner sign',
  'A gold-and-emerald look fit for a royal ball',
  'Ocean-liner postcard style with vintage travel poster colors',
];

/** Picks `n` different prompts at random, avoiding the ones in `avoid` (what was shown last time) when the pool allows it. */
export function pickIdeas(n: number, avoid: readonly string[] = [], rand: () => number = Math.random): string[] {
  const fresh = IDEAS.filter((i) => !avoid.includes(i));
  const pool = (fresh.length >= n ? fresh : IDEAS.slice()).slice();
  // Fisher-Yates shuffle, then take the first n.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}
