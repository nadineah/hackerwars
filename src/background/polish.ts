import { bindArtNames, newArtToken, tokensIn, type ArtRecord } from '../shared/art';
import { commitDesignAndConversation, gcArt, getConversation, getDesignsForHost, loadArtRecords, putConversation } from '../shared/storage';
import { INTENSITY_LEVELS, type ContentState, type Conversation, type Design, type DesignScope, type DomOp, type Provider, type Usage } from '../shared/types';
import { sanitizeCss, sanitizeOps } from '../shared/validate';
import { generateDesign, generateDesignWithArt, MAX_CLAUDE_PICTURES, pickBestVersion, type GenerateInput, type PaintedPicture } from './anthropic';
import { generateIllustrations } from './images';

/**
 * Polish: after a design is applied, Claude looks at a real screenshot of the page and improves it.
 *   1 Quick    - nothing here (one pass).
 *   2 Polished - one screenshot, one pass of targeted corrections.
 *   3 Studio   - a critical rework (new or edited pictures allowed when Intensity allows pictures), a second
 *                screenshot and a final refinement, then the strongest of the versions is kept.
 * Every version is saved as the chat's design, so the page shows it and follow-up messages build on it.
 */

export interface PolishContext {
  level: number;
  tabId: number;
  signal: AbortSignal;
  provider: Provider;
  apiKey: string;
  model: string;
  /** 1-5; pictures are allowed in the Studio rework when it is 2 or more and there is an OpenAI key. */
  intensity: number;
  imageKey: string;
  /** The user's words for this turn. */
  request: string;
  host: string;
  path: string;
  scope: DesignScope;
  pageContext: string;
  applied: { label: string; css: string; ops: DomOp[] }[];
  designId: string;
  designHost: string;
  conversationId: string;
  /** The assistant message of this turn; its snapshot follows each saved version. */
  botMessageId: string;
  onUsage: (u: Usage) => void;
  imageUsage: (u: Usage) => void;
  /** Serialises storage writes with everything else in the background. */
  enqueue: <T>(job: () => Promise<T>) => Promise<T>;
  /** A screenshot of the tab as base64 JPEG. */
  capture: (tabId: number) => Promise<{ ok: true; data: string } | { ok: false; error: string }>;
  /** Short status for the panel ("Checking the result..."). */
  progress?: (text: string) => void;
  /** For tests: how long to let the page settle after a version is applied. */
  settleMs?: number;
  /** How long to wait for the user to come back to the tab before giving up (default 5 minutes). */
  returnWaitMs?: number;
}

export interface PolishResult {
  /** One short paragraph for the chat about what the review did. */
  note: string;
  usage: Usage;
}

interface Version {
  css: string;
  ops: DomOp[];
  shot?: string;
}

const STOPPED = 'Review stopped; the last version is kept.';

export const POLISHED_REVIEW = `Automatic review (Polish: Polished). The screenshot above shows the page right now, with your design applied. Inspect it like an art director and make targeted corrections only:
- text that is hard to read (low contrast, text over busy artwork, placeholder or label colours),
- spacing, alignment and sizing problems, clipped or overlapping elements, doubled borders,
- leftovers from the original site that clash with the design,
- pictures that are badly placed, cropped, scaled, covering content or floating somewhere random,
- anything that breaks the layout, such as a grid that collapsed to one column or large empty areas.
Keep the creative direction, palette, fonts, pictures and everything that already works. Do not make new pictures in this pass. Return the complete corrected design with submit_design. In "reply", say in one short sentence what you fixed, or that nothing needed fixing.`;

export const STUDIO_REWORK = (pictures: boolean) => `Automatic studio review (Polish: Studio). The screenshot above shows the page right now, with your design applied. Critically evaluate the whole result as a demanding creative director, against the user's request, your plan and the intensity level: what is weak, unfinished, generic, unreadable, broken, badly composed or not ambitious enough?
You are not limited to small fixes. Rework whatever is not working: layouts, component styling, the composition, the typography and the artwork. ${
  pictures
    ? 'You may paint new pictures and edit or replace existing ones with plan_artwork (give edit_of the token of an existing picture to change it rather than paint from scratch); keep the pictures that work.'
    : 'No new pictures can be made in this pass (pictures are off at this intensity or there is no image key), so call submit_design directly and work with CSS and the pictures already there.'
}
Keep the user's requested theme and what is already strong, and keep the site usable. Return the complete improved design. In "reply", say in one or two short sentences what you changed.`;

export const STUDIO_FINAL = `Final refinement (Polish: Studio, last pass). The screenshot above shows the page right now with the reworked design applied. Make targeted corrections only, as a finishing pass: readability, spacing and alignment, clipped or overlapping elements, doubled borders, picture placement and cropping, and anything broken in the layout. Keep the creative direction and everything that works. Do not make new pictures in this pass. Return the complete design with submit_design. In "reply", say in one short sentence what you refined.`;

const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
  cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
});

const isAbort = (e: unknown) => e instanceof Error && (e.name === 'AbortError' || /aborted/i.test(e.message));
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), reject(new DOMException('Aborted', 'AbortError'))), { once: true });
  });

/** Waits until the page shows this version of the design, then a moment longer for pictures, fonts and the colour checks. */
async function waitForVersion(ctx: PolishContext, version: number): Promise<boolean> {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    const state = (await chrome.tabs.sendMessage(ctx.tabId, { type: 'ww:getState' }).catch(() => null)) as ContentState | null;
    if (state && state.versions?.[ctx.designId] === version && state.applied) {
      await sleep(ctx.settleMs ?? 1800, ctx.signal);
      return true;
    }
    await sleep(250, ctx.signal);
  }
  return false;
}

const NOT_ON_SCREEN = 'the tab was not on screen';

/** Whether the tab can be photographed for a review: still the visible tab, a normal (not private) window, same site. */
async function reviewBlocker(ctx: PolishContext): Promise<string | null> {
  const tab = await chrome.tabs.get(ctx.tabId).catch(() => undefined);
  if (!tab) return 'the tab was closed';
  if (tab.incognito) return 'screenshots are never taken in private windows';
  if (!tab.active) return NOT_ON_SCREEN;
  const win = await chrome.windows?.get(tab.windowId).catch(() => undefined);
  if (win?.state === 'minimized') return NOT_ON_SCREEN;
  try {
    if (new URL(tab.url ?? '').hostname !== ctx.host) return 'the tab moved to another site';
  } catch {
    return 'the tab moved to another page';
  }
  return null;
}

/** Saves a version as the chat's design (and the turn's snapshot); returns its new version stamp, or null if the chat changed meanwhile. */
async function saveVersion(ctx: PolishContext, v: Version, expectCss: string, art: Map<string, ArtRecord>, usage: Usage, reply?: string): Promise<number | null> {
  return ctx.enqueue(async () => {
    const design = (await getDesignsForHost(ctx.designHost)).find((d) => d.id === ctx.designId);
    const convo = await getConversation(ctx.conversationId);
    const last = convo?.messages[convo.messages.length - 1];
    // something else changed the design or the chat while Claude was reviewing: never overwrite it
    if (!design || !convo || design.css !== expectCss || last?.id !== ctx.botMessageId || convo.revisionIndex !== undefined) return null;
    const used = new Set(tokensIn(`${v.css}\n${JSON.stringify(v.ops)}`));
    const keep = new Map([...art].filter(([t]) => used.has(t)));
    const now = Date.now();
    const next: Design = { ...design, css: v.css, ops: v.ops, updatedAt: now, usage: addUsage(design.usage ?? { inputTokens: 0, outputTokens: 0 }, usage) };
    const messages = convo.messages.map((m) => (m.id === ctx.botMessageId ? { ...m, snapshot: { css: v.css, ops: v.ops }, ...(reply !== undefined ? { text: reply } : {}), usage: addUsage(m.usage ?? { inputTokens: 0, outputTokens: 0 }, usage) } : m));
    const nextConvo: Conversation = { ...convo, messages, updatedAt: now };
    const ok = await commitDesignAndConversation(next, nextConvo, { art: keep });
    if (!ok) return null;
    // the version stamp the design was actually saved with (the save sets its own time)
    return (await getDesignsForHost(ctx.designHost)).find((d) => d.id === ctx.designId)?.updatedAt ?? null;
  });
}

/** Sets the turn's reply text (the review's note), without touching the design. */
async function setReply(ctx: PolishContext, text: string): Promise<void> {
  await ctx.enqueue(async () => {
    const convo = await getConversation(ctx.conversationId);
    if (!convo || convo.messages[convo.messages.length - 1]?.id !== ctx.botMessageId) return;
    await putConversation({ ...convo, messages: convo.messages.map((m) => (m.id === ctx.botMessageId ? { ...m, text } : m)) });
  });
}

/** One review pass: the current design and the screenshot go to the model; returns the new version and its pictures. */
async function reviewPass(ctx: PolishContext, current: Design, shot: string, instructions: string, allowPictures: boolean, names: Map<string, string>): Promise<{ v: Version; art: Map<string, ArtRecord>; reply: string; usage: Usage; problems: string[] }> {
  const convo = await getConversation(ctx.conversationId);
  const history = (convo?.messages ?? []).map((m) => ({ role: m.role, text: [m.text, m.screenshot ? '[attached a screenshot of the page; not resent]' : '', m.imageCount ? `[attached ${m.imageCount} reference image(s); not resent]` : ''].filter(Boolean).join('\n') }));
  const tokens = tokensIn(`${current.css}\n${JSON.stringify(current.ops)}`);
  const existingArt = await loadArtRecords(tokens);
  const wantArt = ctx.intensity >= 2 && !!ctx.imageKey;
  const pictures = allowPictures && wantArt;
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const onUsage = (u: Usage) => {
    usage = addUsage(usage, u);
    ctx.onUsage(u);
  };
  const input: GenerateInput = {
    provider: ctx.provider,
    apiKey: ctx.apiKey,
    model: ctx.model,
    prompt: `${instructions}\n\nThe user's request for this turn was: "${ctx.request || 'see the conversation'}"`,
    host: ctx.host,
    path: ctx.path,
    scope: ctx.scope,
    pageContext: ctx.pageContext,
    history,
    base: { name: current.name, css: current.css, ops: current.ops },
    applied: ctx.applied,
    images: [{ mediaType: 'image/jpeg', data: shot, label: 'screenshot' }],
    illustrations: wantArt,
    intensity: ctx.intensity,
    artwork: Array.from(existingArt, ([token, r]) => ({ token, w: r.w, h: r.h, prompt: r.prompt })),
    maxIllustrations: MAX_CLAUDE_PICTURES,
    signal: ctx.signal,
    onUsage,
  };
  const paint = async (specs: Parameters<typeof generateIllustrations>[0], artDirection: string) => {
    ctx.progress?.('Painting new pictures');
    const edits = await loadArtRecords(specs.map((s) => s.editOf).filter((t): t is string => !!t));
    const made = await generateIllustrations(specs, ctx.imageKey, ctx.signal, { onUsage: ctx.imageUsage, styleSpec: artDirection, referenceFirst: true, existing: edits });
    return { made: made.made as Map<string, PaintedPicture>, problems: made.problems };
  };
  let out: Awaited<ReturnType<typeof generateDesign>>;
  let made = new Map<string, PaintedPicture>();
  let problems: string[] = [];
  if (ctx.provider === 'anthropic' && wantArt) {
    const r = await generateDesignWithArt(input, pictures ? paint : null);
    out = r;
    made = r.made;
    problems = r.artProblems;
  } else {
    out = await generateDesign({ ...input, illustrations: ctx.provider === 'openai' && wantArt });
    if (pictures && out.illustrations.length) {
      const r = await paint(out.illustrations, '');
      made = r.made;
      problems = r.problems;
    }
  }
  // pictures painted in this pass become stored tokens, exactly as in a normal turn
  const art = new Map<string, ArtRecord>();
  for (const [name, rec] of made) {
    const token = newArtToken();
    names.set(name, token);
    art.set(token, rec);
  }
  const css = sanitizeCss(bindArtNames(out.css, names));
  const ops = ctx.scope === 'global' ? [] : sanitizeOps(out.ops.map((o) => (o.op === 'insert' ? { ...o, src: o.src ? bindArtNames(o.src, names) : o.src, style: o.style ? bindArtNames(o.style, names) : o.style } : o)));
  if (!css.trim() && !ops.length) throw new Error('the review returned an empty design');
  return { v: { css, ops }, art, reply: out.reply.replace(/\s+/g, ' ').trim().slice(0, 300), usage, problems };
}

async function currentDesign(ctx: PolishContext): Promise<Design | undefined> {
  return (await getDesignsForHost(ctx.designHost)).find((d) => d.id === ctx.designId);
}

/** Takes the screenshot of the version now on the page (after it has been applied and settled). */
/**
 * Screenshots only see the tab on screen. If you switched away, the review waits for you to come back (the panel says
 * so) instead of skipping; anything else that blocks it (closed tab, another site, a private window) ends it.
 */
async function waitUntilOnScreen(ctx: PolishContext, resume: string): Promise<void> {
  const until = Date.now() + (ctx.returnWaitMs ?? 5 * 60_000);
  let waited = false;
  for (;;) {
    const blocked = await reviewBlocker(ctx);
    if (!blocked) break;
    if (blocked !== NOT_ON_SCREEN) throw new Error(blocked);
    if (Date.now() > until) throw new Error('you did not come back to the tab');
    if (!waited) ctx.progress?.('Waiting for you to return to the tab to check the result');
    waited = true;
    await sleep(500, ctx.signal);
  }
  if (waited) {
    ctx.progress?.(resume);
    // a tab that was hidden may have paused its animations and pictures: give it a moment to draw again
    await sleep(ctx.settleMs ?? 1200, ctx.signal);
  }
}

async function shootVersion(ctx: PolishContext, version: number, resume: string): Promise<string> {
  if (!(await waitForVersion(ctx, version))) throw new Error('the page did not show the new version');
  await waitUntilOnScreen(ctx, resume);
  const shot = await ctx.capture(ctx.tabId);
  if (!shot.ok) throw new Error(shot.error);
  return shot.data;
}

/** Runs the Polish level's review passes. Never throws: problems end the review and keep the last saved version. */
export async function runPolish(ctx: PolishContext, firstReply: string): Promise<PolishResult> {
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  if (ctx.level < 2) return { note: '', usage };
  const blocked = await reviewBlocker(ctx);
  if (blocked && blocked !== NOT_ON_SCREEN) return { note: `Skipped the screenshot review: ${blocked}.`, usage };
  // the review needs the design on screen (a fresh start or Show original may have the page showing the original)
  await chrome.tabs.sendMessage(ctx.tabId, { type: 'ww:setOriginal', original: false }).catch(() => undefined);

  const versions: Version[] = [];
  /** Pictures painted during this review by the name Claude gave them, so later passes can still say ww-asset-<name>. */
  const names = new Map<string, string>();
  const notes: string[] = [];
  let design = await currentDesign(ctx);
  if (!design) return { note: '', usage };
  try {
    ctx.progress?.('Checking the result');
    const shot1 = await shootVersion(ctx, design.updatedAt, 'Checking the result');
    versions.push({ css: design.css, ops: design.ops, shot: shot1 });

    if (ctx.level === 2) {
      ctx.progress?.('Polishing the details');
      const r = await reviewPass(ctx, design, shot1, POLISHED_REVIEW, false, names);
      usage = addUsage(usage, r.usage);
      const note = `Checked a screenshot: ${r.reply || 'refined the details.'}`;
      const saved = await saveVersion(ctx, r.v, design.css, r.art, r.usage, `${firstReply}\n\n${note}`.slice(0, 1600));
      if (saved === null) return { note: 'The review result was not saved because the chat changed meanwhile.', usage };
      return { note, usage };
    }

    // Studio: rework, check again, refine, then keep the strongest version
    ctx.progress?.('Reviewing it like a creative director');
    const pictures = ctx.intensity >= 2 && !!ctx.imageKey;
    const rework = await reviewPass(ctx, design, shot1, STUDIO_REWORK(pictures), true, names);
    usage = addUsage(usage, rework.usage);
    notes.push(`Reworked it: ${rework.reply || 'improved the weak parts.'}`);
    if (rework.problems.length) notes.push(`(Some new pictures could not be made: ${rework.problems[0]}.)`);
    let stamp = await saveVersion(ctx, rework.v, design.css, rework.art, rework.usage, `${firstReply}\n\n${notes.join(' ')}`.slice(0, 1600));
    if (stamp === null) return { note: 'The review result was not saved because the chat changed meanwhile.', usage };
    design = (await currentDesign(ctx))!;

    ctx.progress?.('Checking the reworked version');
    const shot2 = await shootVersion(ctx, stamp, 'Checking the reworked version');
    versions.push({ css: design.css, ops: design.ops, shot: shot2 });

    ctx.progress?.('Final refinement');
    const fin = await reviewPass(ctx, design, shot2, STUDIO_FINAL, false, names);
    usage = addUsage(usage, fin.usage);
    notes.push(`Refined it: ${fin.reply || 'polished the details.'}`);
    stamp = await saveVersion(ctx, fin.v, design.css, fin.art, fin.usage, `${firstReply}\n\n${notes.join(' ')}`.slice(0, 1600));
    if (stamp === null) return { note: notes.join(' '), usage };
    design = (await currentDesign(ctx))!;

    ctx.progress?.('Comparing the versions');
    const shot3 = await shootVersion(ctx, stamp, 'Comparing the versions');
    versions.push({ css: design.css, ops: design.ops, shot: shot3 });
    let judgeUsage: Usage = { inputTokens: 0, outputTokens: 0 };
    const best = await pickBestVersion({
      provider: ctx.provider,
      apiKey: ctx.apiKey,
      model: ctx.model,
      request: ctx.request,
      intensityName: INTENSITY_LEVELS[ctx.intensity - 1]?.name ?? 'Simple',
      shots: versions.map((v) => v.shot!),
      signal: ctx.signal,
      onUsage: (u) => {
        judgeUsage = addUsage(judgeUsage, u);
        ctx.onUsage(u);
      },
    });
    usage = addUsage(usage, judgeUsage);
    const labels = ['the first version', 'the reworked version', 'the refined version'];
    if (best.index < versions.length - 1) {
      // a later pass made it worse: put the strongest version back
      notes.push(`Kept ${labels[best.index]}, which came out strongest${best.reason ? ` (${best.reason})` : ''}.`);
      const keep = versions[best.index];
      await saveVersion(ctx, { css: keep.css, ops: keep.ops }, design.css, new Map(), judgeUsage, `${firstReply}\n\n${notes.join(' ')}`.slice(0, 1600));
    } else {
      notes.push('The final version came out strongest.');
      await setReply(ctx, `${firstReply}\n\n${notes.join(' ')}`.slice(0, 1600));
    }
    return { note: notes.join(' '), usage };
  } catch (e) {
    const why = isAbort(e) || ctx.signal.aborted ? STOPPED : `The review could not finish (${e instanceof Error ? e.message.slice(0, 120) : String(e)}); the last version is kept.`;
    notes.push(why);
    await setReply(ctx, `${firstReply}\n\n${notes.join(' ')}`.slice(0, 1600)).catch(() => undefined);
    return { note: notes.join(' '), usage };
  } finally {
    // pictures from versions that were not kept
    await gcArt().catch(() => undefined);
  }
}
