import {
  LIMITS,
  THEME_FORMAT_VERSION,
  isLicenseId,
  normalizeHostname,
  supportedSite,
  SUPPORTED_SITES,
  validateCommunityCss,
  validatePathScope,
  versionHash,
  type Appearance,
  type LicenseId,
  type PathScope,
  type ThemeVersionPayload,
} from '../../../../theme-core/src';
import { all, get, newId, run, tx, type Db, type SqlParam } from '../db';
import {
  AppError,
  cleanChangeNotes,
  cleanCompatNotes,
  cleanDescription,
  forbidden,
  normalizeTags,
  notFound,
  slugify,
  validateAppearance,
  validateTitle,
} from '../validation';
import { requireModerator, requireUser } from './accounts';

// ------------------------------------------------------------------------------------------ shapes

export type ThemeStatus = 'draft' | 'published' | 'unpublished';
export type VersionState = 'draft' | 'published' | 'retired';

export interface ThemeCard {
  id: string;
  slug: string;
  title: string;
  hostname: string;
  siteName: string;
  tags: string[];
  appearance: Appearance;
  status: ThemeStatus;
  creator: { userId: string; username: string; displayName: string; official: boolean };
  previewMediaId: string | null;
  saveCount: number;
  version: number | null;
  updatedAt: number;
  publishedAt: number | null;
}

export interface VersionInfo {
  id: string;
  version: number;
  state: VersionState;
  pathScope: PathScope;
  css: string;
  changeNotes: string;
  hash: string;
  validationStatus: 'valid' | 'invalid';
  validationReport: { errors: { code: string; message: string; line?: number }[]; warnings: { code: string; message: string; line?: number }[] };
  minExtensionVersion: string | null;
  createdAt: number;
  publishedAt: number | null;
}

export interface ThemeDetail extends ThemeCard {
  description: string;
  license: LicenseId;
  compatNotes: string;
  unpublishedBy: 'owner' | 'moderation' | null;
  previews: { id: string; mediaId: string; role: 'before' | 'after' | 'extra'; position: number; alt: string }[];
  /** The version the public (and the extension) gets: the published one. */
  current: VersionInfo | null;
  /** The version being edited, if any (owner view only). */
  draft: VersionInfo | null;
  versions: { id: string; version: number; state: VersionState; publishedAt: number | null; changeNotes: string }[];
}

interface ThemeRow {
  id: string; owner_id: string; slug: string; title: string; description: string; hostname: string; tags: string;
  appearance: Appearance; status: ThemeStatus; license: LicenseId; compat_notes: string; current_version_id: string | null;
  unpublished_by: 'owner' | 'moderation' | null; created_at: number; updated_at: number; published_at: number | null;
}
interface VersionRow {
  id: string; theme_id: string; version: number; state: VersionState; hostname: string; path_scope: string; css: string;
  format_version: number; min_extension_version: string | null; change_notes: string; hash: string;
  validation_status: 'valid' | 'invalid'; validation_report: string; created_at: number; published_at: number | null;
}

const MAX_THEMES_PER_USER = 50;
const MIN_EXTENSION_VERSION = '0.2.0';

const parseJson = <T>(s: string, fallback: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

const toVersion = (r: VersionRow): VersionInfo => ({
  id: r.id,
  version: r.version,
  state: r.state,
  pathScope: parseJson<PathScope>(r.path_scope, { mode: 'all' }),
  css: r.css,
  changeNotes: r.change_notes,
  hash: r.hash,
  validationStatus: r.validation_status,
  validationReport: parseJson(r.validation_report, { errors: [], warnings: [] }),
  minExtensionVersion: r.min_extension_version,
  createdAt: r.created_at,
  publishedAt: r.published_at,
});

// ------------------------------------------------------------------------------------------ cards / queries

const CARD_SELECT = `
  SELECT t.id, t.slug, t.title, t.hostname, t.tags, t.appearance, t.status, t.updated_at, t.published_at,
         p.user_id AS creator_id, p.username, p.display_name, p.official,
         v.version AS version,
         (SELECT COUNT(*) FROM saved_themes s WHERE s.theme_id = t.id) AS saves,
         (SELECT media_id FROM theme_previews pv WHERE pv.theme_id = t.id
            ORDER BY CASE pv.role WHEN 'after' THEN 0 WHEN 'extra' THEN 1 ELSE 2 END, pv.position LIMIT 1) AS preview_media_id
  FROM themes t
  JOIN profiles p ON p.user_id = t.owner_id
  LEFT JOIN theme_versions v ON v.id = t.current_version_id`;

interface CardRow {
  id: string; slug: string; title: string; hostname: string; tags: string; appearance: Appearance; status: ThemeStatus;
  updated_at: number; published_at: number | null; creator_id: string; username: string; display_name: string; official: number;
  version: number | null; saves: number; preview_media_id: string | null;
}

const toCard = (r: CardRow): ThemeCard => ({
  id: r.id,
  slug: r.slug,
  title: r.title,
  hostname: r.hostname,
  siteName: supportedSite(r.hostname)?.name ?? r.hostname,
  tags: parseJson<string[]>(r.tags, []),
  appearance: r.appearance,
  status: r.status,
  creator: { userId: r.creator_id, username: r.username, displayName: r.display_name, official: !!r.official },
  previewMediaId: r.preview_media_id,
  saveCount: r.saves,
  version: r.version,
  updatedAt: r.updated_at,
  publishedAt: r.published_at,
});

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export interface ListOptions {
  q?: string;
  hostname?: string;
  tag?: string;
  appearance?: Appearance;
  sort?: 'recent' | 'saved';
  page?: number;
  pageSize?: number;
}

/** Public gallery listing. ONLY published themes ever appear here. */
export function listPublishedThemes(db: Db, opts: ListOptions = {}): { items: ThemeCard[]; total: number; page: number; pages: number; pageSize: number } {
  const pageSize = Math.min(48, Math.max(1, opts.pageSize ?? 12));
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const where: string[] = ["t.status = 'published'"];
  const params: SqlParam[] = [];
  if (opts.hostname) {
    where.push('t.hostname = ?');
    params.push(opts.hostname);
  }
  if (opts.appearance) {
    where.push('t.appearance = ?');
    params.push(opts.appearance);
  }
  if (opts.tag) {
    where.push('EXISTS (SELECT 1 FROM json_each(t.tags) j WHERE j.value = ?)');
    params.push(opts.tag.toLowerCase());
  }
  const q = (opts.q ?? '').trim().toLowerCase().slice(0, 80);
  if (q) {
    const like = `%${likeEscape(q)}%`;
    // Also match the friendly site name ("wiki" -> en.wikipedia.org), not just the hostname.
    const siteHosts = SUPPORTED_SITES.filter((s) => s.name.toLowerCase().includes(q)).map((s) => s.hostname);
    const clauses = [
      "lower(t.title) LIKE ? ESCAPE '\\'",
      "lower(t.description) LIKE ? ESCAPE '\\'",
      "lower(t.tags) LIKE ? ESCAPE '\\'",
      "t.hostname LIKE ? ESCAPE '\\'",
      "lower(p.display_name) LIKE ? ESCAPE '\\'",
    ];
    params.push(like, like, like, like, like);
    if (siteHosts.length) {
      clauses.push(`t.hostname IN (${siteHosts.map(() => '?').join(',')})`);
      params.push(...siteHosts);
    }
    where.push(`(${clauses.join(' OR ')})`);
  }
  const order = opts.sort === 'saved' ? 'saves DESC, t.published_at DESC' : 't.published_at DESC';
  const whereSql = where.join(' AND ');
  const total = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM themes t JOIN profiles p ON p.user_id = t.owner_id WHERE ${whereSql}`, ...params)!.n;
  const rows = all<CardRow>(db, `${CARD_SELECT} WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, pageSize, (page - 1) * pageSize);
  return { items: rows.map(toCard), total, page, pages: Math.max(1, Math.ceil(total / pageSize)), pageSize };
}

export function listFeatured(db: Db, limit = 6): ThemeCard[] {
  // "Featured" is just the most saved (real data), then newest. Nothing is hand-picked or invented.
  return listPublishedThemes(db, { sort: 'saved', pageSize: limit }).items;
}

export function listThemesByCreator(db: Db, username: string): ThemeCard[] {
  const rows = all<CardRow>(db, `${CARD_SELECT} WHERE t.status = 'published' AND p.username = ? ORDER BY t.published_at DESC`, username.toLowerCase());
  return rows.map(toCard);
}

/** The filter options actually in use, so the UI only offers choices that have results. */
export function galleryFacets(db: Db): { hostnames: { hostname: string; name: string; count: number }[]; tags: { tag: string; count: number }[] } {
  const hostnames = all<{ hostname: string; n: number }>(db, "SELECT hostname, COUNT(*) AS n FROM themes WHERE status = 'published' GROUP BY hostname ORDER BY n DESC");
  const tags = all<{ tag: string; n: number }>(db, "SELECT j.value AS tag, COUNT(*) AS n FROM themes t, json_each(t.tags) j WHERE t.status = 'published' GROUP BY j.value ORDER BY n DESC, j.value LIMIT 24");
  return {
    hostnames: hostnames.map((h) => ({ hostname: h.hostname, name: supportedSite(h.hostname)?.name ?? h.hostname, count: h.n })),
    tags: tags.map((t) => ({ tag: t.tag, count: t.n })),
  };
}

// ------------------------------------------------------------------------------------------ details

function loadDetail(db: Db, row: ThemeRow, opts: { includeDraft: boolean }): ThemeDetail {
  const card = toCard(get<CardRow>(db, `${CARD_SELECT} WHERE t.id = ?`, row.id)!);
  const versions = all<VersionRow>(db, 'SELECT * FROM theme_versions WHERE theme_id = ? ORDER BY version DESC', row.id);
  const current = row.current_version_id ? versions.find((v) => v.id === row.current_version_id) : undefined;
  const draft = opts.includeDraft ? versions.find((v) => v.state === 'draft') : undefined;
  const previews = all<{ id: string; media_id: string; role: 'before' | 'after' | 'extra'; position: number; alt: string }>(
    db,
    "SELECT id, media_id, role, position, alt FROM theme_previews WHERE theme_id = ? ORDER BY CASE role WHEN 'before' THEN 0 WHEN 'after' THEN 1 ELSE 2 END, position",
    row.id,
  );
  return {
    ...card,
    description: row.description,
    license: row.license,
    compatNotes: row.compat_notes,
    unpublishedBy: row.unpublished_by,
    previews: previews.map((p) => ({ id: p.id, mediaId: p.media_id, role: p.role, position: p.position, alt: p.alt })),
    current: current && row.status === 'published' ? toVersion(current) : null,
    draft: draft ? toVersion(draft) : null,
    versions: versions
      .filter((v) => opts.includeDraft || v.state !== 'draft')
      .map((v) => ({ id: v.id, version: v.version, state: v.state, publishedAt: v.published_at, changeNotes: v.change_notes })),
  };
}

/** A published theme by slug. Drafts and unpublished themes are indistinguishable from "not found". */
export function getPublishedThemeBySlug(db: Db, slug: string): ThemeDetail | null {
  const row = get<ThemeRow>(db, "SELECT * FROM themes WHERE slug = ? AND status = 'published'", slug);
  return row ? loadDetail(db, row, { includeDraft: false }) : null;
}

/** The owner's own view of a theme in any state. Everyone else gets "not found", never "forbidden". */
export function getThemeForOwner(db: Db, userId: string, themeId: string): ThemeDetail {
  const row = get<ThemeRow>(db, 'SELECT * FROM themes WHERE id = ?', themeId);
  if (!row || row.owner_id !== userId) throw notFound('That theme');
  return loadDetail(db, row, { includeDraft: true });
}

/** The owner's theme by slug, in any state. Anyone else gets "not found". */
export function getOwnedThemeBySlug(db: Db, userId: string, slug: string): ThemeDetail {
  const row = get<ThemeRow>(db, 'SELECT * FROM themes WHERE slug = ? AND owner_id = ?', slug, userId);
  if (!row) throw notFound('That theme');
  return loadDetail(db, row, { includeDraft: true });
}

export function listOwnThemes(db: Db, userId: string): ThemeCard[] {
  return all<CardRow>(db, `${CARD_SELECT} WHERE t.owner_id = ? ORDER BY t.updated_at DESC`, userId).map(toCard);
}

// ------------------------------------------------------------------------------------------ inputs

export interface ThemeMetaInput {
  title: unknown;
  description?: unknown;
  hostname: unknown;
  tags?: unknown;
  appearance: unknown;
  license: unknown;
  compatNotes?: unknown;
}
export interface VersionInput {
  css: unknown;
  pathScope: unknown;
  changeNotes?: unknown;
}

function validateMeta(input: ThemeMetaInput): { title: string; description: string; hostname: string; tags: string[]; appearance: Appearance; license: LicenseId; compatNotes: string } {
  const hostname = normalizeHostname(input.hostname);
  if (!hostname || !supportedSite(hostname)) {
    throw new AppError(400, `Choose a supported website: ${SUPPORTED_SITES.map((s) => s.name).join(', ')}.`, 'hostname');
  }
  if (!isLicenseId(input.license)) throw new AppError(400, 'Choose a license.', 'license');
  return {
    title: validateTitle(input.title),
    description: cleanDescription(input.description),
    hostname,
    tags: normalizeTags(input.tags),
    appearance: validateAppearance(input.appearance),
    license: input.license,
    compatNotes: cleanCompatNotes(input.compatNotes),
  };
}

/** Validates CSS + scope for a specific host. Returns what to store, even when invalid (so drafts can be saved). */
async function evaluateVersion(hostname: string, input: VersionInput): Promise<{
  css: string; pathScope: PathScope; hash: string; status: 'valid' | 'invalid'; report: string; changeNotes: string;
}> {
  const raw = typeof input.css === 'string' ? input.css : '';
  const report = validateCommunityCss(raw);
  const scopeIssues = validatePathScope(input.pathScope);
  const pathScope = scopeIssues.length === 0 ? (input.pathScope as PathScope) : ({ mode: 'all' } as PathScope);
  const errors = [...report.errors, ...scopeIssues.map((i) => ({ code: 'scope', message: i.message }))];
  const valid = report.ok && scopeIssues.length === 0;
  const css = valid ? report.css : raw.slice(0, LIMITS.cssBytes * 2);
  return {
    css,
    pathScope,
    hash: await versionHash({ hostname, pathScope, css }),
    status: valid ? 'valid' : 'invalid',
    report: JSON.stringify({ errors, warnings: report.warnings, stats: report.stats }),
    changeNotes: cleanChangeNotes(input.changeNotes),
  };
}

function uniqueSlug(db: Db, title: string): string {
  const base = slugify(title);
  if (!get(db, 'SELECT 1 AS x FROM themes WHERE slug = ?', base)) return base;
  for (let i = 2; i < 50; i++) if (!get(db, 'SELECT 1 AS x FROM themes WHERE slug = ?', `${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}

// ------------------------------------------------------------------------------------------ drafts

export async function createDraft(db: Db, userId: string, meta: ThemeMetaInput, version: VersionInput): Promise<ThemeDetail> {
  requireUser(db, userId);
  const m = validateMeta(meta);
  const count = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM themes WHERE owner_id = ?', userId)!.n;
  if (count >= MAX_THEMES_PER_USER) throw new AppError(400, `You can have up to ${MAX_THEMES_PER_USER} themes.`);
  const v = await evaluateVersion(m.hostname, version);
  return tx(db, () => {
    const id = newId();
    const now = Date.now();
    run(db, 'INSERT INTO themes (id, owner_id, slug, title, description, hostname, tags, appearance, status, license, compat_notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, userId, uniqueSlug(db, m.title), m.title, m.description, m.hostname, JSON.stringify(m.tags), m.appearance, 'draft', m.license, m.compatNotes, now, now);
    run(db, 'INSERT INTO theme_versions (id, theme_id, version, state, hostname, path_scope, css, format_version, min_extension_version, change_notes, hash, validation_status, validation_report, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      newId(), id, 'draft', m.hostname, JSON.stringify(v.pathScope), v.css, THEME_FORMAT_VERSION, MIN_EXTENSION_VERSION, v.changeNotes, v.hash, v.status, v.report, now);
    return getThemeForOwner(db, userId, id);
  });
}

/** Owner-only. The target website is fixed once a theme exists; everything else about the listing can change. */
export function updateMeta(db: Db, userId: string, themeId: string, meta: Omit<ThemeMetaInput, 'hostname'>): ThemeDetail {
  const row = ownedThemeRow(db, userId, themeId);
  const m = validateMeta({ ...meta, hostname: row.hostname });
  run(db, 'UPDATE themes SET title = ?, description = ?, tags = ?, appearance = ?, license = ?, compat_notes = ?, updated_at = ? WHERE id = ?',
    m.title, m.description, JSON.stringify(m.tags), m.appearance, m.license, m.compatNotes, Date.now(), themeId);
  return getThemeForOwner(db, userId, themeId);
}

function ownedThemeRow(db: Db, userId: string, themeId: string): ThemeRow {
  const row = get<ThemeRow>(db, 'SELECT * FROM themes WHERE id = ?', themeId);
  if (!row || row.owner_id !== userId) throw notFound('That theme'); // not "forbidden": do not reveal it exists
  return row;
}

/**
 * Saves CSS/scope into the working draft version. A theme that has never been published edits version 1;
 * a published one gets (or reuses) a NEW draft version, so the live version is never touched until the
 * creator explicitly publishes.
 */
export async function saveDraftVersion(db: Db, userId: string, themeId: string, input: VersionInput): Promise<ThemeDetail> {
  const row = ownedThemeRow(db, userId, themeId);
  const v = await evaluateVersion(row.hostname, input);
  tx(db, () => {
    const draft = get<VersionRow>(db, "SELECT * FROM theme_versions WHERE theme_id = ? AND state = 'draft'", themeId);
    const now = Date.now();
    if (draft) {
      run(db, 'UPDATE theme_versions SET path_scope = ?, css = ?, change_notes = ?, hash = ?, validation_status = ?, validation_report = ? WHERE id = ?', JSON.stringify(v.pathScope), v.css, v.changeNotes, v.hash, v.status, v.report, draft.id);
    } else {
      const next = get<{ n: number }>(db, 'SELECT COALESCE(MAX(version), 0) + 1 AS n FROM theme_versions WHERE theme_id = ?', themeId)!.n;
      run(db, 'INSERT INTO theme_versions (id, theme_id, version, state, hostname, path_scope, css, format_version, min_extension_version, change_notes, hash, validation_status, validation_report, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        newId(), themeId, next, 'draft', row.hostname, JSON.stringify(v.pathScope), v.css, THEME_FORMAT_VERSION, MIN_EXTENSION_VERSION, v.changeNotes, v.hash, v.status, v.report, now);
    }
    run(db, 'UPDATE themes SET updated_at = ? WHERE id = ?', now, themeId);
  });
  return getThemeForOwner(db, userId, themeId);
}

// ------------------------------------------------------------------------------------------ previews

export function addPreview(db: Db, userId: string, themeId: string, mediaId: string, role: 'before' | 'after' | 'extra', alt: string): ThemeDetail {
  ownedThemeRow(db, userId, themeId);
  const m = get<{ owner_id: string }>(db, 'SELECT owner_id FROM media WHERE id = ?', mediaId);
  if (!m) throw notFound('That image');
  if (m.owner_id !== userId) throw forbidden('You can only use images you uploaded.');
  if (!['before', 'after', 'extra'].includes(role)) throw new AppError(400, 'Unknown preview type.');
  const count = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM theme_previews WHERE theme_id = ?', themeId)!.n;
  if (count >= 8) throw new AppError(400, 'A theme can have up to 8 preview images.');
  tx(db, () => {
    // One "before" and one "after" at most: a new one replaces the old.
    if (role !== 'extra') run(db, 'DELETE FROM theme_previews WHERE theme_id = ? AND role = ?', themeId, role);
    const pos = get<{ n: number }>(db, 'SELECT COALESCE(MAX(position), -1) + 1 AS n FROM theme_previews WHERE theme_id = ?', themeId)!.n;
    run(db, 'INSERT INTO theme_previews (id, theme_id, media_id, role, position, alt) VALUES (?, ?, ?, ?, ?, ?)', newId(), themeId, mediaId, role, pos, cleanDescription(alt).slice(0, 140));
    run(db, 'UPDATE themes SET updated_at = ? WHERE id = ?', Date.now(), themeId);
  });
  return getThemeForOwner(db, userId, themeId);
}

export function removePreview(db: Db, userId: string, themeId: string, previewId: string): ThemeDetail {
  ownedThemeRow(db, userId, themeId);
  run(db, 'DELETE FROM theme_previews WHERE id = ? AND theme_id = ?', previewId, themeId);
  return getThemeForOwner(db, userId, themeId);
}

// ------------------------------------------------------------------------------------------ publishing

export interface PublishChecks {
  ok: boolean;
  problems: string[];
}

/** What must be true before publishing, so the UI can show a checklist and the server can enforce it. */
export function publishChecks(db: Db, userId: string, themeId: string, permissionConfirmed: boolean): PublishChecks {
  const t = getThemeForOwner(db, userId, themeId);
  const problems: string[] = [];
  if (!t.draft && !t.current) problems.push('There is no CSS to publish yet.');
  if (t.draft && t.draft.validationStatus !== 'valid') problems.push('The CSS has problems that must be fixed first.');
  if (t.previews.length === 0) problems.push('Add at least one preview image.');
  if (!permissionConfirmed) problems.push('Confirm that you have the right to share this theme and its screenshots.');
  if (!supportedSite(t.hostname)) problems.push('The target website is not supported.');
  if (t.status === 'unpublished' && t.unpublishedBy === 'moderation') problems.push('This theme was unpublished by a moderator and cannot be republished.');
  if (t.status === 'published' && !t.draft) problems.push('There are no unpublished changes to publish.');
  // An owner-unpublished theme with no pending edit has nothing new to publish: it is brought back with "Republish".
  if (t.status === 'unpublished' && t.unpublishedBy !== 'moderation' && !t.draft) problems.push('Use "Republish" to bring back the published version, or edit it first to publish changes.');
  return { ok: problems.length === 0, problems };
}

/**
 * Publishes the working draft as the theme's next version. Previous published versions become "retired":
 * still fetchable by anyone who installed them, but no longer offered. Nothing already installed changes.
 */
export function publish(db: Db, userId: string, themeId: string, opts: { permissionConfirmed: boolean }): ThemeDetail {
  const checks = publishChecks(db, userId, themeId, opts.permissionConfirmed);
  if (!checks.ok) throw new AppError(400, checks.problems[0], 'publish');
  tx(db, () => {
    const draft = get<VersionRow>(db, "SELECT * FROM theme_versions WHERE theme_id = ? AND state = 'draft'", themeId);
    if (!draft) throw new AppError(400, 'There is no draft version to publish.');
    const now = Date.now();
    run(db, "UPDATE theme_versions SET state = 'retired' WHERE theme_id = ? AND state = 'published'", themeId);
    run(db, "UPDATE theme_versions SET state = 'published', published_at = ? WHERE id = ?", now, draft.id);
    run(db, "UPDATE themes SET status = 'published', current_version_id = ?, unpublished_by = NULL, published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?", draft.id, now, now, themeId);
  });
  return getThemeForOwner(db, userId, themeId);
}

/** Owner takes their own theme offline. (Moderators use moderation.unpublishByModerator.) */
export function unpublishByOwner(db: Db, userId: string, themeId: string): ThemeDetail {
  const row = ownedThemeRow(db, userId, themeId);
  if (row.status !== 'published') throw new AppError(400, 'This theme is not published.');
  run(db, "UPDATE themes SET status = 'unpublished', unpublished_by = 'owner', updated_at = ? WHERE id = ?", Date.now(), themeId);
  return getThemeForOwner(db, userId, themeId);
}

/** Owner brings back a theme THEY unpublished (never one a moderator removed). */
export function republishByOwner(db: Db, userId: string, themeId: string): ThemeDetail {
  const row = ownedThemeRow(db, userId, themeId);
  if (row.status !== 'unpublished') throw new AppError(400, 'This theme is not unpublished.');
  if (row.unpublished_by === 'moderation') throw forbidden('A moderator unpublished this theme, so it cannot be republished.');
  if (!row.current_version_id) throw new AppError(400, 'There is no published version to bring back.');
  run(db, "UPDATE themes SET status = 'published', unpublished_by = NULL, updated_at = ? WHERE id = ?", Date.now(), themeId);
  return getThemeForOwner(db, userId, themeId);
}

/** Owner deletes the theme and its previews. Returns image files to remove from disk. */
export function deleteTheme(db: Db, userId: string, themeId: string): string[] {
  ownedThemeRow(db, userId, themeId);
  return tx(db, () => {
    const media = all<{ id: string; file: string }>(db, 'SELECT m.id, m.file FROM media m JOIN theme_previews p ON p.media_id = m.id WHERE p.theme_id = ?', themeId);
    run(db, 'DELETE FROM themes WHERE id = ?', themeId);
    // Remove preview images no other theme still uses.
    const gone: string[] = [];
    for (const m of media) {
      const inUse = get(db, 'SELECT 1 AS x FROM theme_previews WHERE media_id = ?', m.id) || get(db, 'SELECT 1 AS x FROM profiles WHERE avatar_id = ?', m.id);
      if (!inUse) {
        run(db, 'DELETE FROM media WHERE id = ?', m.id);
        gone.push(m.file);
      }
    }
    return gone;
  });
}

// ------------------------------------------------------------------------------------------ saves ("My library")

export function saveTheme(db: Db, userId: string, themeId: string): void {
  requireUser(db, userId);
  const t = get<{ status: ThemeStatus }>(db, 'SELECT status FROM themes WHERE id = ?', themeId);
  if (!t || t.status !== 'published') throw notFound('That theme');
  run(db, 'INSERT OR IGNORE INTO saved_themes (user_id, theme_id, created_at) VALUES (?, ?, ?)', userId, themeId, Date.now());
}

/** Removing from your collection never touches the theme itself. */
export function unsaveTheme(db: Db, userId: string, themeId: string): void {
  run(db, 'DELETE FROM saved_themes WHERE user_id = ? AND theme_id = ?', userId, themeId);
}

export function isSavedBy(db: Db, userId: string, themeId: string): boolean {
  return !!get(db, 'SELECT 1 AS x FROM saved_themes WHERE user_id = ? AND theme_id = ?', userId, themeId);
}

/** Saved themes, including ones that are no longer available (status says so). */
export function listSaved(db: Db, userId: string): ThemeCard[] {
  return all<CardRow>(db, `${CARD_SELECT} JOIN saved_themes sv ON sv.theme_id = t.id AND sv.user_id = ? ORDER BY sv.created_at DESC`, userId).map(toCard);
}

// ------------------------------------------------------------------------------------------ extension payload

/**
 * The exact, versioned payload the browser extension installs. Only PUBLISHED themes are served; an
 * unpublished or moderated theme can no longer be newly installed. A specific version may be requested
 * (retired versions stay fetchable so an existing install can be re-verified). The stored hash is
 * recomputed from the stored data, so a tampered or corrupted row is never served.
 */
export async function getVersionPayload(db: Db, themeId: string, versionId?: string): Promise<ThemeVersionPayload | null> {
  const t = get<ThemeRow>(db, "SELECT * FROM themes WHERE id = ? AND status = 'published'", themeId);
  if (!t) return null;
  const v = versionId
    ? get<VersionRow>(db, "SELECT * FROM theme_versions WHERE id = ? AND theme_id = ? AND state IN ('published','retired')", versionId, themeId)
    : get<VersionRow>(db, "SELECT * FROM theme_versions WHERE id = ? AND state = 'published'", t.current_version_id ?? '');
  if (!v || v.validation_status !== 'valid') return null;
  const pathScope = parseJson<PathScope>(v.path_scope, { mode: 'all' });
  const recomputed = await versionHash({ hostname: v.hostname, pathScope, css: v.css, formatVersion: v.format_version });
  if (recomputed !== v.hash) throw new AppError(500, 'Stored theme failed its integrity check.');
  const creator = get<{ username: string; display_name: string }>(db, 'SELECT username, display_name FROM profiles WHERE user_id = ?', t.owner_id);
  if (!creator) return null;
  return {
    formatVersion: v.format_version,
    themeId: t.id,
    versionId: v.id,
    version: v.version,
    slug: t.slug,
    title: t.title,
    creator: { username: creator.username, displayName: creator.display_name },
    appearance: t.appearance,
    license: t.license,
    hostname: v.hostname,
    pathScope,
    css: v.css,
    hash: v.hash,
    minExtensionVersion: v.min_extension_version ?? undefined,
    publishedAt: new Date(v.published_at ?? v.created_at).toISOString(),
  };
}

/**
 * Who may fetch an uploaded image. Preview images of PUBLISHED themes and avatars are public; everything
 * else (previews of drafts / unpublished themes, orphan uploads) is visible only to its owner and moderators.
 * Image ids are unguessable UUIDs, but visibility is still enforced rather than relying on secrecy.
 */
export function mediaVisibleTo(db: Db, mediaId: string, viewer: { id: string; role: 'user' | 'moderator' } | null): boolean {
  const m = get<{ owner_id: string }>(db, 'SELECT owner_id FROM media WHERE id = ?', mediaId);
  if (!m) return false;
  if (viewer && (viewer.id === m.owner_id || viewer.role === 'moderator')) return true;
  if (get(db, 'SELECT 1 AS x FROM profiles WHERE avatar_id = ?', mediaId)) return true;
  return !!get(db, "SELECT 1 AS x FROM theme_previews p JOIN themes t ON t.id = p.theme_id WHERE p.media_id = ? AND t.status = 'published'", mediaId);
}

/** A moderator action; kept here because it must change the same rows publish/unpublish do. */
export function unpublishByModerator(db: Db, moderatorId: string, themeId: string): void {
  requireModerator(db, moderatorId);
  const t = get<{ status: ThemeStatus }>(db, 'SELECT status FROM themes WHERE id = ?', themeId);
  if (!t) throw notFound('That theme');
  run(db, "UPDATE themes SET status = 'unpublished', unpublished_by = 'moderation', updated_at = ? WHERE id = ?", Date.now(), themeId);
}
