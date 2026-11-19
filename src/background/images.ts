import { MAX_ART_DATA_CHARS, MAX_ART_PER_DESIGN, type ArtRecord } from '../shared/art';
import type { Usage } from '../shared/types';

/**
 * Illustration generation (OpenAI image model only). The design model describes the pictures it wants; this turns
 * those descriptions into small, locally stored images. Nothing from the page is sent: only the model's descriptions.
 */
/** OpenAI's current image models: gpt-image-2.5-flare (fast, high-quality everyday generation) and gpt-image-2.5-sunburst (editing precision). gpt-image-1 was shut down. */
export const IMAGE_MODEL = 'gpt-image-2.5-flare';

export type Shape = 'wide' | 'tall' | 'square';

export interface IllustrationSpec {
  /** The name the design model gave it (lowercase letters, digits, hyphens). */
  id: string;
  prompt: string;
  shape: Shape;
  transparent: boolean;
}

const SIZES: Record<Shape, string> = { wide: '1536x1024', tall: '1024x1536', square: '1024x1024' };
/** The long edge a stored picture is shrunk to, by shape. */
const MAX_EDGE: Record<Shape, number> = { wide: 1280, tall: 1280, square: 1024 };

/** Cleans what the model asked for: valid names only, at most MAX_ART_PER_DESIGN, plain-text prompts. */
export function cleanSpecs(raw: unknown, max: number = MAX_ART_PER_DESIGN): IllustrationSpec[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: IllustrationSpec[] = [];
  for (const r of raw) {
    if (out.length >= max) break;
    const o = r as Record<string, unknown>;
    const id = typeof o?.id === 'string' ? o.id.trim().toLowerCase() : '';
    const prompt = typeof o?.prompt === 'string' ? o.prompt.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 900) : '';
    if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(id) || seen.has(id) || prompt.length < 8) continue;
    const shape: Shape = o.shape === 'tall' || o.shape === 'square' ? o.shape : 'wide';
    seen.add(id);
    out.push({ id, prompt, shape, transparent: o.transparent === true });
  }
  return out;
}

const toBase64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Shrinks and re-encodes the picture as WebP (keeping transparency) so it stays small enough to store. */
export async function shrinkArt(b64: string, shape: Shape): Promise<{ data: string; w: number; h: number }> {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bin]));
  const scale = Math.min(1, MAX_EDGE[shape] / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  for (const q of [0.82, 0.68, 0.5, 0.35]) {
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: q });
    const data = `data:image/webp;base64,${toBase64(await blob.arrayBuffer())}`;
    if (data.length <= MAX_ART_DATA_CHARS) return { data, w, h };
  }
  throw new Error('The picture was too large to keep.');
}

export interface ImageDeps {
  fetch?: typeof fetch;
  shrink?: typeof shrinkArt;
  /** Called with each image's token usage as soon as OpenAI reports it (so it is counted even if the rest fails). */
  onUsage?: (usage: Usage) => void;
  /** One art-direction paragraph written by the design model; put in front of EVERY picture's prompt so they match. */
  styleSpec?: string;
  /** Make the first picture alone, then paint the rest as new assets in the same style, using it as a reference image. */
  referenceFirst?: boolean;
  }

interface MadeImage {
  record: ArtRecord;
  b64: string;
  /** The format OpenAI returned it in, needed to send it back as a reference. */
  type: 'image/webp' | 'image/jpeg';
}

/** What OpenAI documents for one medium-quality image, used only if a response carries no usage of its own. */
const FALLBACK_OUTPUT_TOKENS: Record<Shape, number> = { square: 1056, wide: 1584, tall: 1584 };

/** Token usage of one image response: what OpenAI reported, or the documented size when it reported nothing. */
export function imageUsage(body: unknown, shape: Shape): Usage {
  const u = (body as { usage?: { input_tokens?: unknown; output_tokens?: unknown } } | null)?.usage;
  const input = Number(u?.input_tokens);
  const output = Number(u?.output_tokens);
  if (Number.isFinite(output) && output > 0) return { inputTokens: Number.isFinite(input) && input > 0 ? input : 0, outputTokens: output };
  return { inputTokens: 0, outputTokens: FALLBACK_OUTPUT_TOKENS[shape] };
}

export interface IllustrationResult {
  /** Generated pictures by the name the design model gave them. */
  made: Map<string, ArtRecord>;
  /** Why some were not made (a short, plain sentence), empty when all worked. */
  problems: string[];
}

const NO_TEXT = 'No text, letters, numbers, logos or watermarks anywhere in the image.';

function formatFor(spec: IllustrationSpec): { output_format: 'webp' | 'jpeg'; type: MadeImage['type'] } {
  // WebP keeps transparency and is much smaller than PNG; JPEG for opaque scenery.
  return spec.transparent ? { output_format: 'webp', type: 'image/webp' } : { output_format: 'jpeg', type: 'image/jpeg' };
}

async function failure(res: Response, what: string): Promise<Error> {
  let detail = '';
  try {
    detail = (await res.json())?.error?.message ?? '';
  } catch {
    /* no body */
  }
  return new Error(`${what} ${res.status}${detail ? `: ${String(detail).slice(0, 160)}` : ''}`);
}

async function oneImage(spec: IllustrationSpec, apiKey: string, signal: AbortSignal | undefined, deps: ImageDeps, ref?: { b64: string; type: MadeImage['type'] }): Promise<MadeImage> {
  const f = deps.fetch ?? fetch;
  const fmt = formatFor(spec);
  const style = deps.styleSpec?.trim() ? `Art direction shared by every picture of this website: ${deps.styleSpec.trim()}\n\n` : '';
  let res: Response | undefined;
  if (ref) {
    // A new asset painted in the same hand as the first picture, using that picture as the reference.
    const bin = Uint8Array.from(atob(ref.b64), (c) => c.charCodeAt(0));
    const fd = new FormData();
    fd.append('model', IMAGE_MODEL);
    fd.append('image[]', new Blob([bin], { type: ref.type }), ref.type === 'image/webp' ? 'reference.webp' : 'reference.jpg');
    fd.append('prompt', `${style}Create a NEW, separate asset in exactly the same art style, palette, materials, lighting and level of detail as the reference image. Do not copy its composition or scene. The new asset: ${spec.prompt}\n\n${NO_TEXT}`);
    fd.append('size', SIZES[spec.shape]);
    fd.append('quality', 'medium');
    fd.append('n', '1');
    fd.append('background', spec.transparent ? 'transparent' : 'auto');
    fd.append('output_format', fmt.output_format);
    fd.append('output_compression', '85');
    const r = await f('https://api.openai.com/v1/images/edits', { method: 'POST', signal, headers: { authorization: `Bearer ${apiKey}` }, body: fd });
    if (r.ok) res = r;
    // otherwise fall back to a plain generation that still carries the shared style text
  }
  if (!res) {
    res = await f('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: IMAGE_MODEL,
        prompt: `${style}${spec.prompt}\n\n${NO_TEXT}`,
        size: SIZES[spec.shape],
        quality: 'medium',
        n: 1,
        background: spec.transparent ? 'transparent' : 'auto',
        output_format: fmt.output_format,
        output_compression: 85,
      }),
    });
  }
  if (!res.ok) throw await failure(res, 'OpenAI images');
  const body = await res.json();
  // An image was made and billed whether or not it can be kept, so count it right away.
  deps.onUsage?.(imageUsage(body, spec.shape));
  const b64 = body?.data?.[0]?.b64_json;
  if (typeof b64 !== 'string' || !b64) throw new Error('OpenAI returned no image.');
  const small = await (deps.shrink ?? shrinkArt)(b64, spec.shape);
  return { record: { ...small, prompt: spec.prompt.slice(0, 200) }, b64, type: fmt.type };
}

/** Makes every requested picture in parallel. One failing never loses the others or the design. */
export async function generateIllustrations(specs: IllustrationSpec[], apiKey: string, signal?: AbortSignal, deps: ImageDeps = {}): Promise<IllustrationResult> {
  let results: PromiseSettledResult<MadeImage>[];
  if (deps.referenceFirst && specs.length > 1) {
    const first = (await Promise.allSettled([oneImage(specs[0], apiKey, signal, deps)]))[0];
    const ref = first.status === 'fulfilled' ? { b64: first.value.b64, type: first.value.type } : undefined;
    const rest = await Promise.allSettled(specs.slice(1).map((sp) => oneImage(sp, apiKey, signal, deps, ref)));
    results = [first, ...rest];
  } else {
    results = await Promise.allSettled(specs.map((sp) => oneImage(sp, apiKey, signal, deps)));
  }
  const made = new Map<string, ArtRecord>();
  const problems: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') made.set(specs[i].id, r.value.record);
    else if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    else problems.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
  });
  return { made, problems: Array.from(new Set(problems)) };
}
