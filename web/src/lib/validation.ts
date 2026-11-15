import { LIMITS } from '../../../theme-core/src/format';

/** An error whose message is safe to show to the user, with the HTTP status it maps to. */
export class AppError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what = 'That page') => new AppError(404, `${what} could not be found.`);
export const forbidden = (msg = 'You do not have permission to do that.') => new AppError(403, msg);
export const unauthorized = () => new AppError(401, 'Please sign in to continue.');

/** Strips control characters and normalizes whitespace; never trusts raw input. */
export function cleanText(input: unknown, max: number): string {
  if (typeof input !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g, '').trim().slice(0, max);
}

const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'moderator', 'mod', 'support', 'help', 'api', 'auth', 'login', 'logout', 'signin', 'signup',
  'settings', 'library', 'publish', 'explore', 'themes', 'creators', 'install', 'privacy', 'terms', 'whimsyweb', 'official', 'root', 'system', 'null', 'undefined',
]);
const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{2,23}$/;

/** Returns the normalized (lowercase) username or throws a user-facing error. */
export function validateUsername(input: unknown, opts: { allowReserved?: boolean } = {}): string {
  const u = typeof input === 'string' ? input.trim().toLowerCase() : '';
  if (!USERNAME_RE.test(u)) {
    throw new AppError(400, 'Usernames are 3 to 24 characters: lowercase letters, numbers, "-" and "_", starting with a letter or number.', 'username');
  }
  if (!opts.allowReserved && RESERVED_USERNAMES.has(u)) throw new AppError(400, 'That username is reserved.', 'username');
  return u;
}

export function validateDisplayName(input: unknown): string {
  const n = cleanText(input, 40);
  if (n.length < 1) throw new AppError(400, 'Please enter a display name (up to 40 characters).', 'displayName');
  return n;
}

export const cleanBio = (input: unknown): string => cleanText(input, 280);

export function validateTitle(input: unknown): string {
  const t = cleanText(input, LIMITS.titleChars);
  if (t.length < 3) throw new AppError(400, `Give the theme a title (3 to ${LIMITS.titleChars} characters).`, 'title');
  return t;
}

export const cleanDescription = (input: unknown): string => cleanText(input, LIMITS.descriptionChars);
export const cleanChangeNotes = (input: unknown): string => cleanText(input, LIMITS.changeNotesChars);
export const cleanCompatNotes = (input: unknown): string => cleanText(input, 400);

/** Tags are lowercase words: letters, numbers, spaces and hyphens, deduplicated and capped. */
export function normalizeTags(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : [];
  const out: string[] = [];
  for (const t of raw) {
    const tag = cleanText(t, LIMITS.tagChars).toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/\s+/g, ' ').trim();
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= LIMITS.tags) break;
  }
  return out;
}

export const APPEARANCES = ['light', 'dark', 'mixed'] as const;
export function validateAppearance(input: unknown): (typeof APPEARANCES)[number] {
  if (APPEARANCES.includes(input as never)) return input as (typeof APPEARANCES)[number];
  throw new AppError(400, 'Choose light, dark or mixed.', 'appearance');
}

export const REPORT_REASONS = [
  { id: 'harmful', label: 'Harmful or deceptive (hides or fakes important controls)' },
  { id: 'sensitive', label: 'Targets a sign-in, payment or other sensitive page' },
  { id: 'copyright', label: 'Copyright or trademark problem' },
  { id: 'personal-info', label: 'Shows personal information in its previews' },
  { id: 'broken', label: 'Does not work or breaks the website' },
  { id: 'other', label: 'Something else' },
] as const;
export function validateReportReason(input: unknown): string {
  if (REPORT_REASONS.some((r) => r.id === input)) return input as string;
  throw new AppError(400, 'Please choose a reason.', 'reason');
}

export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'theme';
}

/** Semantic-ish compare for extension versions like "0.2.0" (numeric parts only). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
