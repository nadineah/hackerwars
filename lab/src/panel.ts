import { cleanChecklist, neutralize, scopeNoteFor, systemPromptFor, type ChecklistItem } from '../../src/background/anthropic';
import { IMAGE_MODEL, imageUsage, shrinkArt, type Shape } from '../../src/background/images';
import { artKey, newArtToken, tokensIn, type ArtRecord } from '../../src/shared/art';
import { MODEL_OPTIONS, providerOf, type DomOp, type Usage } from '../../src/shared/types';
import { sanitizeCss, sanitizeOps } from '../../src/shared/validate';
import { watchActivation } from '../../src/shared/tabguard';
import { runAgent, SAFETY_MAX_TURNS, type AgentTool, type ToolResult } from './agent';

/**
 * Whimsy Lab: a bench for trying different SYSTEM PROMPTS. The model is given tools (take a screenshot, apply CSS to the page,
 * generate an image, submit the design) and YOUR PROMPT decides the workflow: what to look at first, how many pictures, how
 * many rounds of refinement. The lab only runs the tools the model asks for. Nothing here touches the main extension's designs.
 */

// ---------------------------------------------------------------------------------------------- state

interface Variant {
  id: string;
  name: string;
  text: string;
}
interface Settings {
  anthropicKey: string;
  openaiKey: string;
  model: string;
  autoShot: boolean;
}
interface Step {
  kind: 'model' | 'tool';
  title: string;
  detail?: string;
  thumbs?: { label: string; thumb: string }[];
  ms?: number;
}
interface Run {
  id: string;
  createdAt: number;
  variantId: string;
  variantName: string;
  system: string;
  model: string;
  request: string;
  scope: 'site' | 'page';
  host: string;
  path: string;
  name: string;
  plan: string;
  reply: string;
  css: string;
  ops: DomOp[];
  ms: number;
  usage?: Usage;
  imageCount: number;
  /** Everything the model did, in order: what it said, each tool it used, each screenshot and picture. */
  steps?: Step[];
  /** Pictures that were made, with small previews. */
  assets?: { id: string; token: string; prompt: string; thumb: string; w: number; h: number }[];
  /** The model's own account of what it did and did not do (if it gave one). */
  checklist?: ChecklistItem[];
  rating?: number;
  note?: string;
  thumb?: string;
  error?: string;
}
interface State {
  settings: Settings;
  variants: Variant[];
  editingId: string;
  batch: string[];
  request: string;
  scope: 'site' | 'page';
  baseRunId: string;
}

const DEFAULTS: State = {
  settings: { anthropicKey: '', openaiKey: '', model: 'claude-sonnet-5-5', autoShot: true },
  variants: [{ id: 'v1', name: 'Blank', text: '' }],
  editingId: 'v1',
  batch: ['v1'],
  request: '',
  scope: 'site',
  baseRunId: '',
};
const MAX_RUNS = 80;

let state: State = structuredClone(DEFAULTS);
let runs: Run[] = [];
let busy = false;
let status = '';
let statusIsError = false;
let gridView = false;
let settingsOpen: boolean | null = null; // null until the first render decides (open when a key is missing)
let filter = '';
let totals = { input: 0, output: 0, calls: 0 };
let abort: AbortController | null = null;

const $app = document.getElementById('app')!;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const uid = () => Math.random().toString(36).slice(2, 10);
const editing = () => state.variants.find((v) => v.id === state.editingId) ?? state.variants[0];

async function load() {
  const got = await chrome.storage.local.get(['lab:state', 'lab:runs']);
  const s = got['lab:state'] as Partial<State> | undefined;
  if (s) state = { ...DEFAULTS, ...s, settings: { ...DEFAULTS.settings, ...(s.settings ?? {}) } };
  if (!state.variants?.length) state.variants = structuredClone(DEFAULTS.variants);
  if (!state.variants.some((v) => v.id === state.editingId)) state.editingId = state.variants[0].id;
  state.batch = (state.batch ?? []).filter((id) => state.variants.some((v) => v.id === id));
  runs = Array.isArray(got['lab:runs']) ? (got['lab:runs'] as Run[]) : [];
}
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void chrome.storage.local.set({ 'lab:state': state, 'lab:runs': runs.slice(0, MAX_RUNS) }), 250);
}

// ---------------------------------------------------------------------------------------------- the page

async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !/^https?:\/\//i.test(tab.url ?? '')) throw new Error('Open a regular website (http or https) in the tab you want to test on.');
  return tab;
}
async function pageSend<T>(tabId: number, msg: Record<string, unknown>): Promise<T> {
  try {
    return (await chrome.tabs.sendMessage(tabId, msg)) as T;
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return (await chrome.tabs.sendMessage(tabId, msg)) as T;
  }
}
const clearPage = async (tabId: number) => void (await pageSend(tabId, { type: 'lab:clear' }).catch(() => undefined));

async function shot(tab: chrome.tabs.Tab, w = 420): Promise<string | undefined> {
  // captureVisibleTab photographs whichever tab is showing. Make sure it is still the tab under test, before AND during.
  const watch = watchActivation();
  try {
    const now = await chrome.tabs.get(tab.id!);
    if (!now.active || now.windowId !== tab.windowId) return undefined;
    const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
    if (watch.changed()) return undefined;
    const after = await chrome.tabs.get(tab.id!);
    if (!after.active) return undefined;
    const bmp = await createImageBitmap(await (await fetch(url)).blob());
    const c = document.createElement('canvas');
    c.width = Math.min(w, bmp.width);
    c.height = Math.round((bmp.height * c.width) / bmp.width);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return c.toDataURL('image/jpeg', 0.75);
  } catch {
    return undefined;
  } finally {
    watch.stop();
  }
}

/** A picture (data URL) as a JPEG the model can look at (transparent areas on mid grey), plus a small preview. */
async function toJpeg(dataUrl: string, maxEdge: number, thumbEdge = 150): Promise<{ base64: string; thumb: string }> {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * scale));
  c.height = Math.max(1, Math.round(bmp.height * scale));
  const g = c.getContext('2d')!;
  g.fillStyle = '#9a9a9a';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const jpeg = c.toDataURL('image/jpeg', 0.85);
  const t = document.createElement('canvas');
  const k = Math.min(1, thumbEdge / Math.max(c.width, c.height));
  t.width = Math.max(1, Math.round(c.width * k));
  t.height = Math.max(1, Math.round(c.height * k));
  t.getContext('2d')!.drawImage(c, 0, 0, t.width, t.height);
  return { base64: jpeg.split(',')[1], thumb: t.toDataURL('image/jpeg', 0.7) };
}

/** Deletes stored pictures that no saved result refers to (failed, stopped and deleted runs leave them behind). */
async function gcArt(): Promise<void> {
  try {
    const keep = new Set<string>();
    for (const r of runs) {
      for (const t of tokensIn(`${r.css}\n${JSON.stringify(r.ops)}`)) keep.add(artKey(t));
      for (const a of r.assets ?? []) keep.add(artKey(a.token));
    }
    const all = await chrome.storage.local.get(null);
    const dead = Object.keys(all).filter((k) => /^art:[a-f0-9]{12}$/.test(k) && !keep.has(k));
    if (dead.length) await chrome.storage.local.remove(dead);
  } catch {
    /* cleanup is best effort */
  }
}

// ---------------------------------------------------------------------------------------------- starting prompts

/** An example of scripting the workflow in the prompt itself (the model has the tools; the prompt decides how to use them). */
const AGENT_EXAMPLE = `You work in this order, using your tools:
1. take_screenshot to see the original page.
2. Decide the art direction (concept, style, palette, motifs) and which pictures would make the page feel illustrated.
3. generate_image for the hero scene first and look at it. Then generate the other assets, passing the hero's id in reference_ids so they match its style.
4. Write the CSS using the real image tokens, apply_css it, then take_screenshot and compare the result with your plan.
5. Fix whatever looks wrong (regenerate images if the artwork is the problem), apply_css and take_screenshot again. Repeat until the whole page looks like one world.
6. submit_design, with a reply that says honestly what you did and anything you could not do.`;

/** The "Load: Art Director" starting prompt (a shared art-direction brief). */
const ART_DIRECTOR = `You are Whimsy Web's creative director, visual designer and website transformation engine.

Your goal is to transform existing websites into cohesive, immersive, art-directed experiences using generated artwork, reusable UI assets and CSS. The entire interface must feel like one visual world. Never make an attractive background and then decorate the rest of the page with unrelated CSS effects.

ART DIRECTION. Before anything else decide: one visual concept; an artistic style (watercolor, storybook, hand-painted, claymation, pixel art, scrapbook, vintage print...); a palette of 5-7 colours with roles; materials and textures; a shape language; lighting and depth; a display font and a readable body font; 2-3 recurring motifs; and the hero moment. These decisions are one shared design system for both the pictures and the CSS.

ASSET KIT. Plan a small, carefully coordinated set of pictures: one hero scene, plus UI component assets (card frame, button surface, section banner, divider, badge) and a few accents (corner decorations, small objects, stickers). A cohesive card frame or button surface often helps more than another large illustration.

HOW TO BRIEF THE ARTWORK. Every picture follows the same style, palette, lighting, textures and shape language. For components: transparent background when it will layer over elements; keep the centre plain and readable and put the detail at the edges and corners; make it tolerant of different text lengths and sizes; no text, labels or icons inside the picture; do not stretch complex illustrations.

BUILD. Use the pictures for complex illustration, themed surfaces, frames, organic shapes and scenery. Use CSS for layout, typography, spacing, responsiveness, colours, simple gradients, subtle shadows, hover and focus states, transitions and accessibility. Use shared CSS variables. Apply each component asset consistently to all related elements. Do not layer CSS decoration over detailed artwork: no repeating sprinkles or geometric patterns, harsh multicoloured gradients, heavy text shadows, oversized shapes, inconsistent borders or competing textures. The pictures carry the expressive complexity; CSS makes it polished, functional and integrated.

PRESERVE the site: text readable, controls clickable, hover/active/focus states clear, artwork never blocking content, layouts responsive, backgrounds not overwhelming, reduced-motion respected.

FOLLOW-UPS. Keep the established visual direction unless asked for a new theme. Reuse existing assets; change CSS without new pictures when that is enough; any new picture must match the existing artwork. Never invent asset identifiers. If picture generation fails, say so plainly instead of claiming an illustrated design.

Core principle: think of the pictures and the UI as one design system. Every element, from the hero to the smallest button, should look like it was made by the same artist for this website.`;

/** The Experimental Mode text, exactly as written. */
const EXPERIMENTAL_MODE_PROMPT = `### Experimental Mode — Prioritize Visual Fidelity

Webloom is currently an experimental test-lab extension. Optimize for design quality, creativity, and faithful implementation rather than minimizing API costs.

- Do not impose arbitrary limits on the number of generated illustrations or UI assets.
- Generate additional assets whenever they would meaningfully improve fidelity to the target mockup.
- Prioritize matching the approved visual concept rather than substituting cheaper CSS approximations.
- Allow multiple screenshot-based refinement passes to correct visual inconsistencies.
- During refinement, regenerate or edit assets when necessary instead of forcing CSS to compensate for unsuitable artwork.
- Preserve generated mockups, assets, and intermediate results for debugging and comparison.
- Keep each stage observable so we can identify whether design planning, image generation, asset integration, or CSS implementation is responsible for a poor result.
- Never report a design as visually validated without inspecting the actual rendered page.
- Preserve the existing CSS-only workflow when illustrations are disabled.

**Primary success criterion:** How closely does the final functioning website reproduce the quality, composition, and visual style of the generated mockup?

Do not simplify designs merely to reduce generation costs. This phase is about determining what is technically and visually possible.`;

// ---------------------------------------------------------------------------------------------- the model's tools

const OPS_SCHEMA = {
  type: 'array',
  description: 'Optional DOM operations (hide, setText, addClass, move, insert). There is NO JavaScript.',
  items: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['hide', 'setText', 'addClass', 'move', 'insert'] },
      selector: { type: 'string', description: 'CSS selector of the element (hide/setText/addClass/move).' },
      target: { type: 'string', description: 'CSS selector of the reference element (move/insert).' },
      position: { type: 'string', enum: ['beforebegin', 'afterbegin', 'beforeend', 'afterend'] },
      text: { type: 'string' },
      className: { type: 'string' },
      tag: { type: 'string', enum: ['div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'section', 'aside', 'header', 'footer', 'hr', 'img', 'em', 'strong', 'small', 'ul', 'li', 'marquee'] },
      style: { type: 'string', description: 'Inline CSS declarations for an inserted element.' },
      src: { type: 'string', description: 'For an inserted img: a generated image token (ww-asset-art:...).' },
    },
    required: ['op'],
  },
} as const;

const TOOLS_BASE: AgentTool[] = [
  {
    name: 'take_screenshot',
    description:
      'Take a screenshot of the web page in the browser tab, exactly as it is rendered right now, including any CSS you applied with apply_css (before any apply_css it is the original site). Returns an image of the visible viewport. Use scroll_y to look further down the page.',
    input_schema: { type: 'object', properties: { scroll_y: { type: 'number', description: 'Optional: scroll the page to this many pixels from the top before the screenshot.' } } },
  },
  {
    name: 'apply_css',
    description:
      'Apply a stylesheet (and optional DOM ops) to the live page so you can look at it with take_screenshot. It replaces whatever you applied before. Pass an empty css to see the original page again. CSS may only load embedded images, Google Fonts and the image tokens (ww-asset-art:...) returned by generate_image: always write url("ww-asset-art:...") with quotes. The safety filter removes anything else, and the result tells you how much it kept.',
    input_schema: { type: 'object', properties: { css: { type: 'string', description: 'The complete stylesheet to inject.' }, ops: OPS_SCHEMA }, required: ['css'] },
  },
  {
    name: 'check_contrast',
    description:
      'Check the live page for text that is hard to read: every visible piece of text is compared with the colour actually behind it (WCAG contrast, 4.5:1 for normal text, 3:1 for large text). Returns the failures with a selector, the text, the ratio, the colours and a suggested replacement colour. Text over images or gradients cannot be judged and is only counted. It looks at what is on the page right now, so call it after apply_css. With fix=true it also corrects the failing colours on the live page itself (darker text is nudged darker, lighter text lighter, keeping the hue); those corrections are NOT part of your CSS: if you want them in the submitted design, put the suggested colours in your own CSS.',
    input_schema: { type: 'object', properties: { fix: { type: 'boolean', description: 'Also apply the suggested colours to the live page. Default false.' } } },
  },
  {
    name: 'submit_design',
    description:
      'Finish: submit the final design. If you omit css (and ops), the design you last applied with apply_css is submitted exactly as it is. Say honestly in reply what you did and anything you could not do.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'A short, charming name for the design (2-5 words).' },
        reply: { type: 'string', description: 'A short message to the user: what you did, and anything you could not do or that did not turn out as planned.' },
        css: { type: 'string', description: 'The complete final stylesheet. Omit to submit what you last applied.' },
        ops: OPS_SCHEMA,
        plan: { type: 'string', description: 'Optional: your design notes.' },
        checklist: {
          type: 'array',
          description: 'Optional: every thing the user asked for, marked done, partial or not_done.',
          items: { type: 'object', properties: { requirement: { type: 'string' }, status: { type: 'string', enum: ['done', 'partial', 'not_done'] }, note: { type: 'string' } }, required: ['requirement', 'status'] },
        },
      },
      required: ['name', 'reply'],
    },
  },
];

const GENERATE_IMAGE_TOOL: AgentTool = {
  name: 'generate_image',
  description:
    `Generate a picture with the image model (${IMAGE_MODEL}); there is no limit on how many you make. The picture is shown to you in the result and you get a token such as ww-asset-art:0123456789ab to use it: in css as background-image:url("ww-asset-art:..."), or as the src of an inserted img op. Pass reference_ids to paint the new picture in the same style as earlier pictures (or "page" for the page as it is right now): the reference images are used as the visual reference. The picture should contain no text, letters or logos.`,
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'A short name for this picture (lowercase letters, digits, hyphens), used in reference_ids later.' },
      prompt: { type: 'string', description: 'What to paint: subject, style, palette, lighting, composition. With reference_ids, describe what the new picture is and how it relates to the references.' },
      shape: { type: 'string', enum: ['wide', 'tall', 'square'], description: 'wide 3:2 for scenery, headers and banners; tall 2:3 for side decorations; square for badges, characters and objects.' },
      transparent: { type: 'boolean', description: 'True for cut-outs and overlays that sit on top of page elements; false for full backgrounds.' },
      quality: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Default medium.' },
      reference_ids: { type: 'array', items: { type: 'string' }, description: 'Ids of earlier pictures (or "page") to use as style/content reference.' },
    },
    required: ['id', 'prompt', 'shape', 'transparent'],
  },
};

const IMAGE_SIZES: Record<Shape, string> = { wide: '1536x1024', tall: '1024x1536', square: '1024x1024' };

// ---------------------------------------------------------------------------------------------- running

function userTextFor(run: Run, pageContext: string, base: Run | undefined, host: string, path: string): string {
  const parts: string[] = [`<page_context>\n${neutralize(pageContext)}\n</page_context>`];
  if (base) {
    parts.push(`<current_design name="${neutralize(base.name)}">\nCSS:\n${neutralize(base.css)}\n\nOps: ${neutralize(JSON.stringify(base.ops))}\n</current_design>`);
    if (base.assets?.length) parts.push(`<available_artwork>\n${base.assets.map((a) => neutralize(`${a.token}: ${a.w}x${a.h}px, ${a.prompt}`)).join('\n')}\n</available_artwork>`);
  }
  parts.push(scopeNoteFor(run.scope, host, path));
  parts.push(`<user_request>\n${neutralize(run.request)}\n</user_request>`);
  return parts.join('\n\n');
}

async function runVariant(v: Variant, tab: chrome.tabs.Tab, pageContext: string, signal: AbortSignal): Promise<Run> {
  const s = state.settings;
  const provider = providerOf(s.model);
  const apiKey = provider === 'openai' ? s.openaiKey : s.anthropicKey;
  const url = new URL(tab.url!);
  const base = runs.find((r) => r.id === state.baseRunId);
  const run: Run = {
    id: uid(),
    createdAt: Date.now(),
    variantId: v.id,
    variantName: v.name,
    system: v.text.trim(), // exactly what is in the editor; blank means nothing is sent
    model: s.model,
    request: state.request.trim(),
    scope: state.scope,
    host: url.hostname,
    path: url.pathname,
    name: '',
    plan: '',
    reply: '',
    css: '',
    ops: [],
    ms: 0,
    imageCount: 0,
    steps: [],
    assets: [],
  };
  const started = Date.now();
  const count = (u: Usage) => {
    run.usage = { inputTokens: (run.usage?.inputTokens ?? 0) + u.inputTokens, outputTokens: (run.usage?.outputTokens ?? 0) + u.outputTokens, cacheReadTokens: (run.usage?.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0) };
    totals = { input: totals.input + u.inputTokens + (u.cacheReadTokens ?? 0), output: totals.output + u.outputTokens, calls: totals.calls + 1 };
  };
  const tabId = tab.id!;

  // The working design (what is on the page right now) and the pictures made so far.
  let lastCss = '';
  let lastOps: DomOp[] = [];
  let finalArgs: Record<string, unknown> | null = null;
  const made = new Map<string, { b64: string; type: 'image/jpeg' | 'image/webp'; token: string }>();

  const apply = async (css: string, ops: DomOp[]) => {
    if (!css.trim() && !ops.length) await pageSend(tabId, { type: 'lab:clear' });
    else await pageSend(tabId, { type: 'lab:apply', css, ops, scope: run.scope });
    await new Promise((r) => setTimeout(r, 1200)); // fonts and images settle
  };

  const doScreenshot = async (input: Record<string, unknown>): Promise<ToolResult> => {
    let m: { scrollY: number; pageHeight: number; viewportHeight: number; viewportWidth: number } | undefined;
    if (typeof input.scroll_y === 'number') m = await pageSend<NonNullable<typeof m>>(tabId, { type: 'lab:scroll', y: input.scroll_y });
    else m = await pageSend<NonNullable<typeof m>>(tabId, { type: 'lab:metrics' }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 400));
    const big = await shot(tab, 1100);
    if (!big) return { text: 'The screenshot was not taken: the tab under test is not the visible tab (or it changed during the capture). Nothing was captured. The user has to bring that tab back to the front.' };
    const small = await shot(tab, 420);
    run.steps!.push({ kind: 'tool', title: 'take_screenshot', detail: m ? `viewport ${m.viewportWidth}x${m.viewportHeight}, scrolled to ${Math.round(m.scrollY)} of ${m.pageHeight}px` : undefined, thumbs: small ? [{ label: 'screenshot', thumb: small }] : undefined });
    return { text: `Screenshot of the page${lastCss ? ' with your applied CSS' : ' (original site, nothing applied)'}${m ? `; viewport ${m.viewportWidth}x${m.viewportHeight}px, scrolled to ${Math.round(m.scrollY)}px of ${m.pageHeight}px total height` : ''}.`, images: [{ base64: big.split(',')[1], mediaType: 'image/jpeg' }] };
  };

  const doContrast = async (input: Record<string, unknown>): Promise<ToolResult> => {
    const fix = input.fix === true;
    const r = await pageSend<{ checked: number; failing: number; fixed: number; unknown: number; failures: { selector: string; text: string; ratio: number; color: string; background: string; suggested: string; reached: boolean }[] }>(tabId, { type: 'lab:contrast', fix });
    const lines = r.failures.map((f) => `${f.selector} "${f.text}": ${f.ratio}:1, text ${f.color} on ${f.background}, suggest ${f.suggested}${f.reached ? '' : ' (best possible, still low)'}`);
    const text = `Checked ${r.checked} pieces of text: ${r.failing} below the readable contrast, ${r.unknown} over images or gradients (not judged).${fix ? ` Corrected ${r.fixed} on the live page.` : ''}${lines.length ? `\n${lines.join('\n')}${r.failing > lines.length ? `\n…and ${r.failing - lines.length} more.` : ''}` : ''}`;
    run.steps!.push({ kind: 'tool', title: 'check_contrast', detail: text });
    return { text };
  };

  const doApply = async (input: Record<string, unknown>): Promise<ToolResult> => {
    const rawCss = String(input.css ?? '');
    const css = sanitizeCss(rawCss);
    const ops = sanitizeOps(Array.isArray(input.ops) ? input.ops : []);
    lastCss = css;
    lastOps = ops;
    await apply(css, ops);
    const dropped = Array.isArray(input.ops) ? input.ops.length - ops.length : 0;
    const note = `Applied to the page. The safety filter kept ${css.length.toLocaleString()} of ${rawCss.length.toLocaleString()} characters of CSS${dropped > 0 ? ` and rejected ${dropped} op(s)` : ''}.${css.length < rawCss.length * 0.9 && rawCss.length > 200 ? ' A lot was removed: check for url() values that are not embedded images, Google Fonts or ww-asset-art tokens.' : ''} Use take_screenshot to look at it.`;
    run.steps!.push({ kind: 'tool', title: 'apply_css', detail: `${css.length.toLocaleString()} chars, ${ops.length} op(s). ${note}` });
    return { text: note };
  };

  const doImage = async (input: Record<string, unknown>): Promise<ToolResult> => {
    const t0 = Date.now();
    if (!s.openaiKey) return { text: 'Image generation is not available: no OpenAI API key is set in the lab Settings.' };
    const id = String(input.id ?? '').toLowerCase().trim();
    const prompt = String(input.prompt ?? '').trim();
    const shape: Shape = input.shape === 'tall' || input.shape === 'square' ? input.shape : 'wide';
    const transparent = input.transparent === true;
    const quality = input.quality === 'low' || input.quality === 'high' ? input.quality : 'medium';
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id) || prompt.length < 4) return { text: 'Invalid arguments: id must be lowercase letters, digits and hyphens, and prompt is required.' };
    // reference pictures: earlier ones by id, or the page as it is right now
    const refs: { b64: string; type: 'image/jpeg' | 'image/webp' }[] = [];
    const missing: string[] = [];
    for (const rid of Array.isArray(input.reference_ids) ? (input.reference_ids as unknown[]).map(String) : []) {
      if (rid === 'page') {
        const p = await shot(tab, 1100);
        if (!p) return { text: 'Could not use the page as a reference: the tab under test is not the visible tab. Nothing was sent.' };
        refs.push({ b64: p.split(',')[1], type: 'image/jpeg' });
      } else if (made.has(rid)) refs.push(made.get(rid)!);
      else missing.push(rid);
    }
    if (missing.length) return { text: `Unknown reference id(s): ${missing.join(', ')}. Pictures made so far: ${[...made.keys()].join(', ') || 'none'}.` };
    const format = transparent ? { output_format: 'webp', type: 'image/webp' as const } : { output_format: 'jpeg', type: 'image/jpeg' as const };
    let res: Response;
    if (refs.length) {
      const fd = new FormData();
      fd.append('model', IMAGE_MODEL);
      refs.forEach((r, i) => fd.append('image[]', new Blob([Uint8Array.from(atob(r.b64), (c) => c.charCodeAt(0))], { type: r.type }), `reference-${i}.${r.type === 'image/webp' ? 'webp' : 'jpg'}`));
      fd.append('prompt', prompt);
      fd.append('size', IMAGE_SIZES[shape]);
      fd.append('quality', quality);
      fd.append('n', '1');
      fd.append('background', transparent ? 'transparent' : 'auto');
      fd.append('output_format', format.output_format);
      fd.append('output_compression', '88');
      res = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', signal, headers: { authorization: `Bearer ${s.openaiKey}` }, body: fd });
    } else {
      res = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${s.openaiKey}` },
        body: JSON.stringify({ model: IMAGE_MODEL, prompt, size: IMAGE_SIZES[shape], quality, n: 1, background: transparent ? 'transparent' : 'auto', output_format: format.output_format, output_compression: 88 }),
      });
    }
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.json())?.error?.message ?? '';
      } catch {
        /* no body */
      }
      const msg = `Image generation failed (${res.status})${detail ? `: ${String(detail).slice(0, 300)}` : ''}`;
      run.steps!.push({ kind: 'tool', title: `generate_image "${id}" failed`, detail: msg, ms: Date.now() - t0 });
      return { text: msg };
    }
    const body = await res.json();
    const u = imageUsage(body, shape);
    count({ inputTokens: u.inputTokens, outputTokens: u.outputTokens });
    const b64 = body?.data?.[0]?.b64_json;
    if (typeof b64 !== 'string' || !b64) return { text: 'The image service returned no image.' };
    const small = await shrinkArt(b64, shape);
    const rec: ArtRecord = { ...small, prompt: prompt.slice(0, 200) };
    const token = newArtToken();
    await chrome.storage.local.set({ [artKey(token)]: rec });
    made.set(id, { b64, type: format.type, token });
    const j = await toJpeg(rec.data, 900, 170);
    run.assets!.push({ id, token, w: rec.w, h: rec.h, prompt: `${shape}${transparent ? ', transparent' : ''}: ${prompt}`, thumb: j.thumb });
    run.imageCount = run.assets!.length;
    run.steps!.push({ kind: 'tool', title: `generate_image "${id}"`, detail: `${shape}${transparent ? ', transparent' : ''}${refs.length ? `, ${refs.length} reference(s)` : ''}. ${prompt}`, thumbs: [{ label: id, thumb: j.thumb }], ms: Date.now() - t0 });
    return { text: `Picture "${id}" created (${rec.w}x${rec.h}px${transparent ? ', transparent' : ''}). Use it as url("${token}") in CSS, or as the src of an inserted img op. It is shown below.`, images: [{ base64: j.base64, mediaType: 'image/jpeg' }] };
  };

  const doSubmit = async (input: Record<string, unknown>): Promise<ToolResult> => {
    const css = typeof input.css === 'string' && input.css.trim() ? sanitizeCss(input.css) : lastCss;
    const ops = Array.isArray(input.ops) && input.ops.length ? sanitizeOps(input.ops) : lastOps;
    if (!css.trim() && !ops.length) return { text: 'There is nothing to submit: pass css, or call apply_css first.' };
    finalArgs = input;
    run.name = String(input.name ?? 'Untitled').slice(0, 60);
    run.reply = String(input.reply ?? '').slice(0, 1500);
    run.plan = typeof input.plan === 'string' ? input.plan.slice(0, 3000) : '';
    run.checklist = cleanChecklist(input.checklist);
    run.css = css;
    run.ops = ops;
    lastCss = css;
    lastOps = ops;
    run.steps!.push({ kind: 'tool', title: 'submit_design', detail: `“${run.name}”. ${run.reply}` });
    return { text: 'Design submitted.', final: true };
  };

  const tools = [...TOOLS_BASE.slice(0, 2), ...(s.openaiKey ? [GENERATE_IMAGE_TOOL] : []), TOOLS_BASE[2], TOOLS_BASE[3]];
  try {
    const result = await runAgent({
      provider,
      apiKey,
      model: s.model,
      system: run.system,
      userText: userTextFor(run, pageContext, base, url.hostname, url.pathname),
      tools,
      execute: async (name, input) => {
        setStatus(`Model is using ${name}… (${run.imageCount} picture(s) made so far, ${run.steps!.filter((x) => x.kind === 'tool').length} tool calls). Press Stop to end the run.`);
        try {
          if (name === 'take_screenshot') return await doScreenshot(input);
          if (name === 'apply_css') return await doApply(input);
          if (name === 'check_contrast') return await doContrast(input);
          if (name === 'generate_image') return await doImage(input);
          if (name === 'submit_design') return await doSubmit(input);
          return { text: `Unknown tool "${name}".` };
        } catch (e) {
          if (signal.aborted || (e instanceof Error && e.name === 'AbortError')) throw e;
          const msg = `The tool failed: ${e instanceof Error ? e.message : String(e)}`;
          run.steps!.push({ kind: 'tool', title: `${name} failed`, detail: msg });
          return { text: msg };
        }
      },
      onUsage: count,
      onEvent: (e) => {
        run.steps!.push({ kind: 'model', title: e.title, detail: e.detail, ms: e.ms });
        setStatus(`${e.title}…`);
      },
      signal,
    });
    if (!result.finished || !finalArgs) throw new Error(result.reason);
    if (tokensIn(run.css).length) run.imageCount = Math.max(run.imageCount, tokensIn(run.css).length);
  } catch (e) {
    run.error = e instanceof Error ? e.message : String(e);
  }
  run.ms = Date.now() - started;
  return run;
}

async function runBatch(ids: string[]) {
  const s = state.settings;
  const provider = providerOf(s.model);
  const key = provider === 'openai' ? s.openaiKey : s.anthropicKey;
  if (!key) return setStatus(`Add your ${provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key under Settings first.`, true);
  if (!state.request.trim()) return setStatus('Write a request first (what the site should look like).', true);
  const variants = ids.map((id) => state.variants.find((v) => v.id === id)).filter((v): v is Variant => !!v);
  if (!variants.length) return setStatus('Pick at least one prompt to run.', true);
  busy = true;
  abort = new AbortController();
  render();
  try {
    const tab = await activeTab();
    for (const [i, v] of variants.entries()) {
      if (abort.signal.aborted) break;
      setStatus(`Run ${i + 1} of ${variants.length}: “${v.name}” on ${new URL(tab.url!).hostname}…`);
      await clearPage(tab.id!); // the outline and the first screenshot must come from the untouched page
      const ctx = await pageSend<{ context: string; ignoredStyles?: number; ignoredInserted?: number }>(tab.id!, { type: 'lab:extract' });
      if (ctx.ignoredStyles || ctx.ignoredInserted) setStatus(`Ignoring Whimsy Web’s own theme on this page (${ctx.ignoredStyles ?? 0} style sheet(s), ${ctx.ignoredInserted ?? 0} inserted element(s)). Run ${i + 1} of ${variants.length}…`);
      const run = await runVariant(v, tab, ctx.context, abort.signal);
      if (abort.signal.aborted) break;
      if (!run.error) {
        await pageSend(tab.id!, { type: 'lab:apply', css: run.css, ops: run.ops, scope: run.scope });
        if (s.autoShot) {
          await new Promise((r) => setTimeout(r, 1300));
          run.thumb = await shot(tab);
        }
      }
      runs.unshift(run);
      render();
      save();
    }
    // A refinement was for this run only: the next request starts from the original page again.
    state.baseRunId = '';
    setStatus(abort.signal.aborted ? 'Stopped.' : 'Done.');
  } catch (e) {
    setStatus(e instanceof Error && e.name === 'AbortError' ? 'Stopped.' : e instanceof Error ? e.message : String(e), true);
  } finally {
    busy = false;
    abort = null;
    render();
    save();
    void gcArt();
  }
}

// ---------------------------------------------------------------------------------------------- view

function setStatus(msg: string, isError = false) {
  status = msg;
  statusIsError = isError;
  const el = document.getElementById('status');
  if (el) {
    el.textContent = msg;
    el.className = isError ? 'err' : 'muted';
  }
}

function runCard(r: Run): string {
  const t = r.usage ? `${(r.usage.inputTokens + (r.usage.cacheReadTokens ?? 0)).toLocaleString()} in / ${r.usage.outputTokens.toLocaleString()} out` : '';
  const toolSteps = (r.steps ?? []).filter((x) => x.kind === 'tool').length;
  return `<div class="card run" data-run="${r.id}">
    <div class="head"><strong>${esc(r.variantName)}</strong><span class="muted">${esc(r.model)} · ${(r.ms / 1000).toFixed(1)}s${t ? ' · ' + t : ''}${r.imageCount ? ' · ' + r.imageCount + ' img' : ''}</span></div>
    ${r.thumb ? `<img class="thumb" src="${r.thumb}" alt="screenshot of the result" />` : ''}
    ${r.error ? `<div class="err">${esc(r.error)}</div>` : `<div><strong>${esc(r.name)}</strong> <span class="muted">${r.css.length.toLocaleString()} chars CSS · ${r.ops.length} ops · ${esc(r.host)}</span></div>`}
    ${r.reply ? `<div class="muted meta">${esc(r.reply)}</div>` : ''}
    ${r.steps?.length ? `<details class="meta"><summary>What the model did (${toolSteps} tool call${toolSteps === 1 ? '' : 's'})</summary>${r.steps.map((g, i) => `<div style="margin-top:6px"><strong>${i + 1}. ${esc(g.title)}</strong>${g.ms ? ` <span class="muted">${(g.ms / 1000).toFixed(1)}s</span>` : ''}${g.detail ? `<div class="muted" style="white-space:pre-wrap">${esc(g.detail.slice(0, 1200))}</div>` : ''}${g.thumbs?.length ? `<div class="row">${g.thumbs.map((im) => `<img class="asset" style="width:${im.label === 'screenshot' ? 140 : 96}px" src="${im.thumb}" title="${esc(im.label)}" alt="${esc(im.label)}" />`).join('')}</div>` : ''}</div>`).join('')}</details>` : ''}
    ${r.checklist?.length ? `<details class="meta" ${r.checklist.some((i) => i.status !== 'done') ? 'open' : ''}><summary>Followed ${r.checklist.filter((i) => i.status === 'done').length} of ${r.checklist.length} requests${r.checklist.some((i) => i.status !== 'done') ? ' · some not done' : ''}</summary><pre>${esc(r.checklist.map((i) => (i.status === 'done' ? '✓ ' : i.status === 'partial' ? '◐ ' : '✗ ') + i.requirement + (i.note ? ' — ' + i.note : '')).join('\n'))}</pre></details>` : ''}
    ${r.assets?.length ? `<div class="row meta">${r.assets.map((a) => `<img class="asset" src="${a.thumb}" title="${esc(a.id + ': ' + a.prompt)}" alt="${esc(a.id)}" />`).join('')}</div>` : ''}
    ${r.plan ? `<details class="meta"><summary>Design notes</summary><pre>${esc(r.plan)}</pre></details>` : ''}
    <div class="row stars">${[1, 2, 3, 4, 5].map((n) => `<button data-act="rate" data-n="${n}" class="${(r.rating ?? 0) >= n ? 'on' : ''}" title="${n}">★</button>`).join('')}</div>
    <input class="note" type="text" data-note placeholder="Notes (what worked, what didn’t)" value="${esc(r.note ?? '')}" />
    <div class="row">
      <button class="small" data-act="preview" ${r.error ? 'disabled' : ''}>Preview</button>
      <button class="small" data-act="shot" ${r.error ? 'disabled' : ''}>Screenshot</button>
      <button class="small" data-act="copycss">Copy CSS</button>
      <button class="small primary" data-act="refine" title="Make your next request an edit of THIS result instead of starting from the original page" ${r.error ? 'disabled' : ''}>Refine this result</button>
      <button class="small" data-act="copyprompt" title="Copy the exact system prompt that was sent for this result">Copy prompt</button>
      <button class="small danger" data-act="delrun">Delete</button>
    </div>
  </div>`;
}

function avg(v: Variant): string {
  const rated = runs.filter((r) => r.variantId === v.id && r.rating);
  return rated.length ? ` ★${(rated.reduce((a, r) => a + (r.rating ?? 0), 0) / rated.length).toFixed(1)}` : '';
}

function render() {
  const s = state.settings;
  const v = editing();
  const keyOk = providerOf(s.model) === 'openai' ? !!s.openaiKey : !!s.anthropicKey;
  if (settingsOpen === null) settingsOpen = !keyOk;
  const shown = runs.filter((r) => !filter || r.variantId === filter);
  const baseRun = runs.find((r) => r.id === state.baseRunId);
  const isCustomModel = !MODEL_OPTIONS.some((m) => m.id === s.model);
  const active = document.activeElement as HTMLElement | null;
  const focusId = active?.id;
  const sel = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] : null;

  $app.innerHTML = `
  <div class="row"><h1 class="grow">Whimsy Lab</h1><span class="muted">${totals.calls} calls · ${totals.input.toLocaleString()} in / ${totals.output.toLocaleString()} out this session</span></div>

  <details class="card" data-settings ${settingsOpen ? 'open' : ''}><summary><strong>Settings</strong> <span class="muted">${esc(s.model)}${keyOk ? '' : ' · needs a key'}</span></summary>
    <label for="anthropicKey">Anthropic API key</label><input id="anthropicKey" type="password" data-set="anthropicKey" value="${esc(s.anthropicKey)}" placeholder="sk-ant-…" />
    <label for="openaiKey">OpenAI API key (also enables the generate_image tool, for any model)</label><input id="openaiKey" type="password" data-set="openaiKey" value="${esc(s.openaiKey)}" placeholder="sk-…" />
    <label for="model">Model</label>
    <select id="model" data-set="model">${MODEL_OPTIONS.map((m) => `<option value="${m.id}" ${m.id === s.model ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}<option value="__custom" ${isCustomModel ? 'selected' : ''}>Custom model id…</option></select>
    ${isCustomModel ? `<input id="customModel" type="text" data-set="customModel" value="${esc(s.model)}" placeholder="model id" style="margin-top:6px" />` : ''}
    <div class="row" style="margin-top:8px">
      <label class="inline"><input type="checkbox" data-set="autoShot" ${s.autoShot ? 'checked' : ''} /> Screenshot each finished result</label>
    </div>
    <div class="muted" style="margin-top:6px">The model works with tools: <strong>take_screenshot</strong>, <strong>apply_css</strong>, <strong>check_contrast</strong>, <strong>generate_image</strong> (when an OpenAI key is set) and <strong>submit_design</strong>. Your prompt decides the whole workflow: the order, how many pictures, how many refinement rounds. There are no settings or limits for these. The only guard is a stop after ${SAFETY_MAX_TURNS} model turns, plus the Stop button. Keys stay in this extension’s own storage. The system prompt is sent exactly as typed (blank means no system prompt at all). Whimsy Web’s own theme is switched off during a run, but text it rewrote or classes it added can’t be undone from here: for a perfectly clean test, turn Whimsy Web off at chrome://extensions.</div>
  </details>

  <section class="card">
    <h2>System prompts</h2>
    <div class="chips">${state.variants
      .map((x) => `<span class="chip ${x.id === state.editingId ? 'on' : ''}" data-act="edit" data-id="${x.id}"><input type="checkbox" data-act="batch" data-id="${x.id}" ${state.batch.includes(x.id) ? 'checked' : ''} title="Include when running several" />${esc(x.name)}${avg(x)}</span>`)
      .join('')}<button class="small" data-act="newvariant">＋ New</button></div>
    <label for="vname">Name</label><input id="vname" type="text" data-vname value="${esc(v.name)}" />
    <label for="sys">Prompt (${v.text.length.toLocaleString()} chars; blank is allowed)</label>
    <textarea id="sys" class="sys" data-vtext placeholder="Write or paste a system prompt here. Tell the model what order to work in, e.g. “take a screenshot, plan the images, generate them, apply the CSS, take a new screenshot, then refine”…">${esc(v.text)}</textarea>
    <div class="row" style="margin-top:6px">
      <button class="small" data-act="load" data-w="agent">Load: Agent workflow (example)</button>
      <button class="small" data-act="load" data-w="artdirector">Load: Art Director (cohesive kit)</button>
      <button class="small" data-act="load" data-w="experimental">Load: Experimental Mode (verbatim)</button>
      <button class="small" data-act="load" data-w="claude">Load: current Whimsy Web prompt</button>
      <button class="small" data-act="dupvariant">Duplicate</button>
      <button class="small" data-act="clearvariant">Clear</button>
      <button class="small danger" data-act="delvariant" ${state.variants.length < 2 ? 'disabled' : ''}>Delete</button>
    </div>
  </section>

  <section class="card">
    <h2>Request</h2>
    <textarea id="request" class="req" data-request placeholder="What should the page become? e.g. frog. frogs everywhere. magical and whimsical">${esc(state.request)}</textarea>
    <div class="row" style="margin-top:6px">
      <select data-scope style="width:auto"><option value="site" ${state.scope === 'site' ? 'selected' : ''}>Whole site</option><option value="page" ${state.scope === 'page' ? 'selected' : ''}>This page only</option></select>
      <span class="muted grow">${baseRun ? `Refining: “${esc(baseRun.variantName)}” result · <a href="#" data-act="unbase">start fresh</a>` : 'Starting from the ORIGINAL page: no earlier result or Whimsy Web theme is used'}</span>
    </div>
    <div class="row" style="margin-top:8px">
      <button class="primary" data-act="run" ${busy ? 'disabled' : ''}>Run “${esc(v.name)}”</button>
      <button data-act="runbatch" ${busy || !state.batch.length ? 'disabled' : ''}>Run ${state.batch.length} checked prompt${state.batch.length === 1 ? '' : 's'}</button>
      <button data-act="stop" ${busy ? '' : 'disabled'}>Stop</button>
      <button data-act="clearpage">Clear page</button>
      <button data-act="release" title="Show the Whimsy Web theme (if the main extension has one on this page) again">Restore Whimsy Web theme</button>
    </div>
    <div id="status" class="${statusIsError ? 'err' : 'muted'}" style="margin-top:6px">${esc(status)}</div>
  </section>

  <section>
    <div class="row"><h2 class="grow">Results (${shown.length})</h2>
      <select data-filter style="width:auto"><option value="">All prompts</option>${state.variants.map((x) => `<option value="${x.id}" ${filter === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
      <label class="inline"><input type="checkbox" data-grid ${gridView ? 'checked' : ''} /> Grid</label>
      <button class="small" data-act="export">Copy all as JSON</button>
      <button class="small danger" data-act="clearruns">Clear results</button>
    </div>
    <div class="${gridView ? 'grid' : ''}" style="display:${gridView ? 'grid' : 'flex'};flex-direction:column;gap:10px;margin-top:8px">${shown.map(runCard).join('') || '<div class="muted">No results yet. Write a request and press Run.</div>'}</div>
  </section>`;

  if (focusId) {
    const el = document.getElementById(focusId) as HTMLInputElement | HTMLTextAreaElement | null;
    if (el) {
      el.focus();
      if (sel && typeof el.setSelectionRange === 'function' && sel[0] !== null) el.setSelectionRange(sel[0], sel[1]);
    }
  }
}

// ---------------------------------------------------------------------------------------------- events

const runOf = (el: Element) => runs.find((r) => r.id === (el.closest('[data-run]') as HTMLElement | null)?.dataset.run);

$app.addEventListener(
  'toggle',
  (e) => {
    const t = e.target as HTMLElement;
    if (t.matches('[data-settings]')) settingsOpen = (t as HTMLDetailsElement).open;
  },
  true,
);

$app.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement | HTMLTextAreaElement;
  if (t.matches('[data-vtext]')) {
    editing().text = t.value;
    save();
    const lab = document.querySelector('label[for="sys"]');
    if (lab) lab.textContent = `Prompt (${t.value.length.toLocaleString()} chars; blank is allowed)`;
  } else if (t.matches('[data-vname]')) {
    editing().name = t.value || 'Untitled';
    save();
  } else if (t.matches('[data-request]')) {
    state.request = t.value;
    save();
  } else if (t.matches('[data-note]')) {
    const r = runOf(t);
    if (r) r.note = t.value;
    save();
  } else if (t.matches('[data-set="anthropicKey"], [data-set="openaiKey"], [data-set="customModel"]')) {
    const k = t.dataset.set as 'anthropicKey' | 'openaiKey' | 'customModel';
    if (k === 'customModel') state.settings.model = t.value.trim();
    else state.settings[k] = t.value.trim();
    save();
  }
});

$app.addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement | HTMLSelectElement;
  if (t.matches('[data-set="model"]')) {
    state.settings.model = t.value === '__custom' ? '' : t.value;
    save();
    render();
  } else if (t.matches('[data-set]') && t instanceof HTMLInputElement && t.type === 'checkbox') {
    (state.settings as unknown as Record<string, boolean>)[t.dataset.set!] = t.checked;
    save();
  } else if (t.matches('[data-scope]')) {
    state.scope = t.value as 'site' | 'page';
    save();
  } else if (t.matches('[data-filter]')) {
    filter = t.value;
    render();
  } else if (t.matches('[data-grid]')) {
    gridView = (t as HTMLInputElement).checked;
    render();
  } else if (t.matches('[data-act="batch"]')) {
    const id = t.dataset.id!;
    state.batch = (t as HTMLInputElement).checked ? [...new Set([...state.batch, id])] : state.batch.filter((x) => x !== id);
    save();
    render();
  }
});

$app.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
  if (!el || el.matches('input')) return;
  const act = el.dataset.act!;
  e.preventDefault();
  void handle(act, el);
});

async function handle(act: string, el: HTMLElement) {
  const v = editing();
  switch (act) {
    case 'edit':
      state.editingId = el.dataset.id!;
      save();
      return render();
    case 'newvariant': {
      const nv = { id: uid(), name: `Prompt ${state.variants.length + 1}`, text: '' };
      state.variants.push(nv);
      state.editingId = nv.id;
      state.batch.push(nv.id);
      save();
      return render();
    }
    case 'dupvariant': {
      const nv = { id: uid(), name: `${v.name} copy`, text: v.text };
      state.variants.push(nv);
      state.editingId = nv.id;
      save();
      return render();
    }
    case 'delvariant':
      if (state.variants.length > 1 && confirm(`Delete the prompt “${v.name}”? Its results stay.`)) {
        state.variants = state.variants.filter((x) => x.id !== v.id);
        state.batch = state.batch.filter((x) => x !== v.id);
        state.editingId = state.variants[0].id;
        save();
        render();
      }
      return;
    case 'clearvariant':
      v.text = '';
      save();
      return render();
    case 'load': {
      const w = el.dataset.w;
      v.text = w === 'agent' ? AGENT_EXAMPLE : w === 'experimental' ? EXPERIMENTAL_MODE_PROMPT : w === 'artdirector' ? ART_DIRECTOR : systemPromptFor('anthropic', false);
      save();
      return render();
    }
    case 'unbase':
      state.baseRunId = '';
      save();
      setStatus('Starting fresh: the next run uses only the original page.');
      return render();
    case 'run':
      return void runBatch([v.id]);
    case 'runbatch':
      return void runBatch(state.batch);
    case 'stop':
      abort?.abort();
      return;
    case 'release': {
      const tab = await activeTab().catch(() => undefined);
      if (tab?.id) {
        await clearPage(tab.id);
        await pageSend(tab.id, { type: 'lab:release' }).catch(() => undefined);
      }
      return setStatus('Whimsy Web’s own theme is back on the page (if it had one).');
    }
    case 'clearpage': {
      const tab = await activeTab().catch(() => undefined);
      if (tab?.id) {
        await clearPage(tab.id);
        await pageSend(tab.id, { type: 'lab:isolate' }).catch(() => undefined);
      }
      return setStatus('Page cleared: showing the original site.');
    }
    case 'clearruns':
      if (confirm('Delete all results?')) {
        runs = [];
        save();
        void gcArt();
        render();
      }
      return;
    case 'export':
      await navigator.clipboard.writeText(JSON.stringify(runs.map(({ thumb, ...r }) => ({ ...r, steps: r.steps?.map(({ thumbs, ...x }) => x) })), null, 2));
      return setStatus(`Copied ${runs.length} results (without images) as JSON.`);
  }

  const r = runOf(el);
  if (!r) return;
  switch (act) {
    case 'rate':
      r.rating = r.rating === Number(el.dataset.n) ? undefined : Number(el.dataset.n);
      save();
      return render();
    case 'delrun':
      runs = runs.filter((x) => x.id !== r.id);
      save();
      void gcArt();
      return render();
    case 'copycss':
      await navigator.clipboard.writeText(r.css);
      return setStatus('CSS copied.');
    case 'copyprompt': {
      const all = r.system.trim() ? r.system : '(blank: no system prompt was sent)';
      await navigator.clipboard.writeText(all);
      return setStatus(`Copied the system prompt sent for “${r.variantName}” (${all.length.toLocaleString()} characters).`);
    }
    case 'refine':
      state.baseRunId = r.id;
      state.request = '';
      save();
      render();
      return setStatus('The next run will refine this result. Write what to change.');
    case 'preview': {
      const tab = await activeTab();
      await clearPage(tab.id!);
      await pageSend(tab.id!, { type: 'lab:apply', css: r.css, ops: r.ops, scope: r.scope });
      return setStatus(`Showing “${r.variantName}” on the page.`);
    }
    case 'shot': {
      const tab = await activeTab();
      r.thumb = await shot(tab);
      save();
      return render();
    }
  }
}

(async () => {
  await load();
  render();
  void gcArt();
})();

