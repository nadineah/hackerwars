import { readMedia } from '@/lib/media';
import { mediaVisibleTo } from '@/lib/repo/themes';
import { currentUser } from '@/lib/session';
import { db } from '@/lib/server';

export const runtime = 'nodejs';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const viewer = await currentUser();
  const viewerInfo = viewer ? { id: viewer.id, role: viewer.role } : null;
  if (!mediaVisibleTo(db(), id, viewerInfo)) return new Response('Not found', { status: 404 });
  const media = readMedia(db(), id);
  if (!media) return new Response('Not found', { status: 404 });
  // An image that is public regardless of who asks may be cached; one only this viewer may see may not.
  const publiclyVisible = mediaVisibleTo(db(), id, null);
  return new Response(new Uint8Array(media.data), {
    headers: {
      'Content-Type': 'image/webp',
      'Cache-Control': publiclyVisible ? 'public, max-age=3600' : 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'none'",
      'Content-Disposition': 'inline',
    },
  });
}
