import { getVersionPayload } from '@/lib/repo/themes';
import { AppError } from '@/lib/validation';
import { checkRateLimit } from '@/lib/ratelimit';
import { clientKey } from '@/lib/action-utils';
import { db } from '@/lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Public, read-only API used by the browser extension to fetch a PUBLISHED theme version:
 *   GET /api/v1/themes/{themeId}            -> the current published version
 *   GET /api/v1/themes/{themeId}?version={versionId} -> that exact version (retired ones stay fetchable)
 * Unpublished, moderated, draft and unknown themes all return the same 404. No cookies are read or set,
 * no user data is returned, and the response is plain JSON that the extension re-validates itself.
 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age': '86400',
  'X-Content-Type-Options': 'nosniff',
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: 'not_found' }, 404);
  const rl = checkRateLimit(db(), `api:theme:${await clientKey()}`, 120, 60_000);
  if (!rl.ok) return json({ error: 'rate_limited' }, 429, { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) });
  const version = new URL(req.url).searchParams.get('version') ?? undefined;
  if (version !== undefined && !/^[0-9a-f-]{36}$/.test(version)) return json({ error: 'not_found' }, 404);
  try {
    const payload = await getVersionPayload(db(), id, version);
    if (!payload) return json({ error: 'not_found' }, 404);
    return json(payload, 200, { 'Cache-Control': 'public, max-age=60' });
  } catch (e) {
    if (e instanceof AppError && e.status === 500) {
      console.error('[api] integrity failure for theme', id);
      return json({ error: 'integrity' }, 500);
    }
    console.error('[api] error', e);
    return json({ error: 'server_error' }, 500);
  }
}

function json(body: unknown, status: number, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra } });
}
