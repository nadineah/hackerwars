import { createHash } from 'node:crypto';
import { headers } from 'next/headers';
import { AppError } from './validation';

/** What a form action returns to the page: a message to show, never a thrown stack trace. */
export type ActionState = { error?: string; ok?: string; field?: string } | null;

/**
 * Runs an action body and turns expected, user-facing failures (AppError) into a message. Anything
 * unexpected is logged on the server and shown generically, so internals are never leaked.
 */
export async function guard(fn: () => Promise<ActionState | void> | ActionState | void): Promise<ActionState> {
  try {
    return (await fn()) ?? null;
  } catch (e) {
    if (e instanceof AppError) return { error: e.message, field: e.field };
    // Next.js implements redirect() by throwing; let those through.
    if (e && typeof e === 'object' && 'digest' in e && String((e as { digest: unknown }).digest).startsWith('NEXT_')) throw e;
    console.error('[action error]', e);
    return { error: 'Something went wrong on our side. Please try again.' };
  }
}

/** A stable, non-reversible key for rate limiting anonymous visitors. The IP itself is never stored. */
export async function clientKey(): Promise<string> {
  const h = await headers();
  const ip = (h.get('x-forwarded-for') ?? '').split(',')[0].trim() || h.get('x-real-ip') || 'unknown';
  return createHash('sha256').update(`${ip}|${process.env.AUTH_SECRET ?? 'dev'}`).digest('hex').slice(0, 24);
}

export const str = (fd: FormData, key: string): string => {
  const v = fd.get(key);
  return typeof v === 'string' ? v : '';
};
