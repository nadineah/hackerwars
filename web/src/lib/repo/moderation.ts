import { all, get, newId, run, tx, type Db } from '../db';
import { AppError, cleanText, notFound, validateReportReason } from '../validation';
import { requireModerator } from './accounts';
import { unpublishByModerator } from './themes';

export interface ReportView {
  id: string;
  themeId: string;
  themeTitle: string;
  themeSlug: string;
  themeStatus: string;
  ownerUsername: string;
  reporter: string | null;
  reason: string;
  detail: string;
  status: 'open' | 'actioned' | 'dismissed';
  createdAt: number;
  resolvedAt: number | null;
  resolutionNote: string | null;
}

/** Anyone (signed in or not) may report a PUBLISHED theme. A reporter's repeat report of the same theme is idempotent. */
export function createReport(db: Db, reporterId: string | null, themeId: string, reasonInput: unknown, detailInput: unknown): { id: string; duplicate: boolean } {
  const reason = validateReportReason(reasonInput);
  const detail = cleanText(detailInput, 600);
  const t = get<{ status: string }>(db, 'SELECT status FROM themes WHERE id = ?', themeId);
  if (!t || t.status !== 'published') throw notFound('That theme');
  if (reporterId) {
    const existing = get<{ id: string }>(db, "SELECT id FROM reports WHERE theme_id = ? AND reporter_id = ? AND status = 'open'", themeId, reporterId);
    if (existing) return { id: existing.id, duplicate: true };
  }
  const id = newId();
  run(db, 'INSERT INTO reports (id, theme_id, reporter_id, reason, detail, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, themeId, reporterId, reason, detail, 'open', Date.now());
  return { id, duplicate: false };
}

interface ReportRow {
  id: string; theme_id: string; title: string; slug: string; theme_status: string; owner_username: string; reporter_username: string | null;
  reason: string; detail: string; status: 'open' | 'actioned' | 'dismissed'; created_at: number; resolved_at: number | null; resolution_note: string | null;
}

/** Moderators only. Shows reporter usernames, never email addresses. */
export function listReports(db: Db, moderatorId: string, status: 'open' | 'actioned' | 'dismissed' | 'all' = 'open'): ReportView[] {
  requireModerator(db, moderatorId);
  const rows = all<ReportRow>(
    db,
    `SELECT r.id, r.theme_id, t.title, t.slug, t.status AS theme_status, po.username AS owner_username, pr.username AS reporter_username,
            r.reason, r.detail, r.status, r.created_at, r.resolved_at, r.resolution_note
     FROM reports r
     JOIN themes t ON t.id = r.theme_id
     JOIN profiles po ON po.user_id = t.owner_id
     LEFT JOIN profiles pr ON pr.user_id = r.reporter_id
     ${status === 'all' ? '' : 'WHERE r.status = ?'}
     ORDER BY r.created_at DESC LIMIT 200`,
    ...(status === 'all' ? [] : [status]),
  );
  return rows.map((r) => ({
    id: r.id, themeId: r.theme_id, themeTitle: r.title, themeSlug: r.slug, themeStatus: r.theme_status, ownerUsername: r.owner_username,
    reporter: r.reporter_username, reason: r.reason, detail: r.detail, status: r.status, createdAt: r.created_at, resolvedAt: r.resolved_at, resolutionNote: r.resolution_note,
  }));
}

function log(db: Db, actorId: string, action: string, themeId: string | null, reportId: string | null, note: string): void {
  run(db, 'INSERT INTO moderation_log (id, actor_id, action, theme_id, report_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', newId(), actorId, action, themeId, reportId, note, Date.now());
}

/** Resolve a report: unpublish the theme (it can no longer be newly installed) or dismiss the report. Always audited. */
export function resolveReport(db: Db, moderatorId: string, reportId: string, action: 'unpublish' | 'dismiss', noteInput: unknown): void {
  requireModerator(db, moderatorId);
  const note = cleanText(noteInput, 400);
  const report = get<{ id: string; theme_id: string; status: string }>(db, 'SELECT id, theme_id, status FROM reports WHERE id = ?', reportId);
  if (!report) throw notFound('That report');
  if (report.status !== 'open') throw new AppError(409, 'That report has already been handled.');
  tx(db, () => {
    const now = Date.now();
    if (action === 'unpublish') {
      unpublishByModerator(db, moderatorId, report.theme_id);
      // Close every open report on this theme: it is no longer published.
      run(db, "UPDATE reports SET status = 'actioned', resolved_by = ?, resolved_at = ?, resolution_note = ? WHERE theme_id = ? AND status = 'open'", moderatorId, now, note, report.theme_id);
      log(db, moderatorId, 'unpublish', report.theme_id, reportId, note);
    } else {
      run(db, "UPDATE reports SET status = 'dismissed', resolved_by = ?, resolved_at = ?, resolution_note = ? WHERE id = ?", moderatorId, now, note, reportId);
      log(db, moderatorId, 'dismiss', report.theme_id, reportId, note);
    }
  });
}

/** Unpublish a theme directly (no report needed). Audited. */
export function moderatorUnpublish(db: Db, moderatorId: string, themeId: string, noteInput: unknown): void {
  requireModerator(db, moderatorId);
  tx(db, () => {
    unpublishByModerator(db, moderatorId, themeId);
    log(db, moderatorId, 'unpublish', themeId, null, cleanText(noteInput, 400));
  });
}

export interface LogEntry {
  id: string;
  actor: string | null;
  action: string;
  themeId: string | null;
  themeTitle: string | null;
  note: string;
  createdAt: number;
}

export function listModerationLog(db: Db, moderatorId: string, limit = 100): LogEntry[] {
  requireModerator(db, moderatorId);
  return all<{ id: string; actor: string | null; action: string; theme_id: string | null; title: string | null; note: string; created_at: number }>(
    db,
    `SELECT l.id, p.username AS actor, l.action, l.theme_id, t.title, l.note, l.created_at
     FROM moderation_log l LEFT JOIN profiles p ON p.user_id = l.actor_id LEFT JOIN themes t ON t.id = l.theme_id
     ORDER BY l.created_at DESC, l.rowid DESC LIMIT ?`,
    Math.min(500, limit),
  ).map((r) => ({ id: r.id, actor: r.actor, action: r.action, themeId: r.theme_id, themeTitle: r.title, note: r.note, createdAt: r.created_at }));
}
