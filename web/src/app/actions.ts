'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { signOut } from '@/lib/auth';
import { clientKey, guard, str, type ActionState } from '@/lib/action-utils';
import { deleteMediaFiles, processImage, storeMedia } from '@/lib/media';
import { deleteAccount, setAvatar, updateProfile } from '@/lib/repo/accounts';
import { createReport, moderatorUnpublish, resolveReport } from '@/lib/repo/moderation';
import * as themes from '@/lib/repo/themes';
import { enforceRateLimit, POLICY } from '@/lib/ratelimit';
import { db } from '@/lib/server';
import { currentUser, requireUserOrThrow } from '@/lib/session';
import { AppError } from '@/lib/validation';

// ------------------------------------------------------------------------------------------ saving

/** Adds/removes a published theme from the signed-in user's personal collection. */
export async function toggleSaveAction(themeId: string, slug: string, save: boolean): Promise<void> {
  const user = await requireUserOrThrow();
  enforceRateLimit(db(), `save:user:${user.id}`, POLICY.save.limit, POLICY.save.windowMs);
  if (save) themes.saveTheme(db(), user.id, themeId);
  else themes.unsaveTheme(db(), user.id, themeId);
  revalidatePath(`/themes/${slug}`);
  revalidatePath('/library');
}

// ------------------------------------------------------------------------------------------ reporting

export async function reportThemeAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return guard(async () => {
    const user = await currentUser();
    const bucket = user ? `report:user:${user.id}` : `report:anon:${await clientKey()}`;
    enforceRateLimit(db(), bucket, POLICY.report.limit, POLICY.report.windowMs);
    const r = createReport(db(), user?.id ?? null, str(fd, 'themeId'), str(fd, 'reason'), str(fd, 'detail'));
    return { ok: r.duplicate ? 'You already reported this theme. A moderator will take a look.' : 'Thanks. A moderator will review this report.' };
  });
}

// ------------------------------------------------------------------------------------------ account

export async function updateProfileAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return guard(async () => {
    const user = await requireUserOrThrow();
    updateProfile(db(), user.id, { username: str(fd, 'username'), displayName: str(fd, 'displayName'), bio: str(fd, 'bio') });
    revalidatePath('/settings');
    return { ok: 'Profile saved.' };
  });
}

export async function uploadAvatarAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return guard(async () => {
    const user = await requireUserOrThrow();
    enforceRateLimit(db(), `upload:user:${user.id}`, POLICY.upload.limit, POLICY.upload.windowMs);
    const file = fd.get('avatar');
    if (!(file instanceof File) || file.size === 0) throw new AppError(400, 'Choose an image first.');
    const processed = await processImage(Buffer.from(await file.arrayBuffer()), 'avatar');
    const { id } = storeMedia(db(), user.id, processed);
    setAvatar(db(), user.id, id);
    revalidatePath('/settings');
    return { ok: 'Avatar updated.' };
  });
}

export async function removeAvatarAction(): Promise<void> {
  const user = await requireUserOrThrow();
  setAvatar(db(), user.id, null);
  revalidatePath('/settings');
}

export async function deleteAccountAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const state = await guard(async () => {
    const user = await requireUserOrThrow();
    if (str(fd, 'confirm').trim().toLowerCase() !== 'delete') throw new AppError(400, 'Type "delete" to confirm.', 'confirm');
    deleteMediaFiles(deleteAccount(db(), user.id));
  });
  if (state?.error) return state;
  await signOut({ redirectTo: '/?deleted=1' });
  return null;
}

// ------------------------------------------------------------------------------------------ publishing

function themeFields(fd: FormData) {
  return {
    title: str(fd, 'title'),
    description: str(fd, 'description'),
    tags: str(fd, 'tags'),
    appearance: str(fd, 'appearance'),
    license: str(fd, 'license'),
    compatNotes: str(fd, 'compatNotes'),
  };
}

/** Reads the scope controls: "all" | "prefix" | "exact" plus one path per line. */
function scopeFields(fd: FormData) {
  const mode = str(fd, 'scopeMode');
  if (mode === 'all') return { mode: 'all' as const };
  const paths = str(fd, 'scopePaths').split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
  return { mode: mode as 'prefix' | 'exact', paths };
}

export async function createDraftAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  let newSlug: string | null = null;
  const state = await guard(async () => {
    const user = await requireUserOrThrow();
    enforceRateLimit(db(), `draft:user:${user.id}`, POLICY.draftSave.limit, POLICY.draftSave.windowMs);
    const css = str(fd, 'css');
    const t = await themes.createDraft(
      db(),
      user.id,
      { ...themeFields(fd), hostname: str(fd, 'hostname') },
      { css, pathScope: scopeFields(fd), changeNotes: str(fd, 'changeNotes') },
    );
    newSlug = t.slug;
  });
  if (state?.error) return state;
  redirect(`/themes/${newSlug}/edit`);
}

export async function saveThemeAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return guard(async () => {
    const user = await requireUserOrThrow();
    enforceRateLimit(db(), `draft:user:${user.id}`, POLICY.draftSave.limit, POLICY.draftSave.windowMs);
    const id = str(fd, 'themeId');
    themes.updateMeta(db(), user.id, id, themeFields(fd));
    const t = await themes.saveDraftVersion(db(), user.id, id, { css: str(fd, 'css'), pathScope: scopeFields(fd), changeNotes: str(fd, 'changeNotes') });
    revalidatePath('/themes/[slug]/edit', 'page');
    const v = t.draft;
    if (v && v.validationStatus === 'invalid') return { error: `Saved, but the CSS has ${v.validationReport.errors.length} problem(s) to fix before publishing.` };
    return { ok: 'Saved.' };
  });
}

export async function uploadPreviewAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return guard(async () => {
    const user = await requireUserOrThrow();
    enforceRateLimit(db(), `upload:user:${user.id}`, POLICY.upload.limit, POLICY.upload.windowMs);
    const themeId = str(fd, 'themeId');
    const role = str(fd, 'role');
    const file = fd.get('image');
    if (!(file instanceof File) || file.size === 0) throw new AppError(400, 'Choose an image first.');
    // Ownership is checked BEFORE spending effort on the image.
    themes.getThemeForOwner(db(), user.id, themeId);
    const processed = await processImage(Buffer.from(await file.arrayBuffer()), 'preview');
    const { id } = storeMedia(db(), user.id, processed);
    themes.addPreview(db(), user.id, themeId, id, role as 'before' | 'after' | 'extra', str(fd, 'alt'));
    revalidatePath('/themes/[slug]/edit', 'page');
    return { ok: 'Image added.' };
  });
}

export async function removePreviewAction(themeId: string, previewId: string): Promise<void> {
  const user = await requireUserOrThrow();
  themes.removePreview(db(), user.id, themeId, previewId);
  revalidatePath('/themes/[slug]/edit', 'page');
}

export async function publishAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  let slug: string | null = null;
  const state = await guard(async () => {
    const user = await requireUserOrThrow();
    enforceRateLimit(db(), `publish:user:${user.id}`, POLICY.publish.limit, POLICY.publish.windowMs);
    const t = themes.publish(db(), user.id, str(fd, 'themeId'), { permissionConfirmed: str(fd, 'permission') === 'on' });
    slug = t.slug;
  });
  if (state?.error) return state;
  redirect(`/themes/${slug}?published=1`);
}

export async function unpublishAction(themeId: string): Promise<void> {
  const user = await requireUserOrThrow();
  themes.unpublishByOwner(db(), user.id, themeId);
  revalidatePath('/library');
  revalidatePath('/themes/[slug]/edit', 'page');
}

export async function republishAction(themeId: string): Promise<void> {
  const user = await requireUserOrThrow();
  themes.republishByOwner(db(), user.id, themeId);
  revalidatePath('/library');
  revalidatePath('/themes/[slug]/edit', 'page');
}

export async function deleteThemeAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const state = await guard(async () => {
    const user = await requireUserOrThrow();
    if (str(fd, 'confirm').trim().toLowerCase() !== 'delete') throw new AppError(400, 'Type "delete" to confirm.', 'confirm');
    deleteMediaFiles(themes.deleteTheme(db(), user.id, str(fd, 'themeId')));
  });
  if (state?.error) return state;
  redirect('/library?deleted=1');
}

// ------------------------------------------------------------------------------------------ moderation

export async function resolveReportAction(fd: FormData): Promise<void> {
  const user = await requireUserOrThrow();
  const action = str(fd, 'action') === 'unpublish' ? 'unpublish' : 'dismiss';
  resolveReport(db(), user.id, str(fd, 'reportId'), action, str(fd, 'note'));
  revalidatePath('/moderation');
}

export async function moderatorUnpublishAction(fd: FormData): Promise<void> {
  const user = await requireUserOrThrow();
  moderatorUnpublish(db(), user.id, str(fd, 'themeId'), str(fd, 'note'));
  revalidatePath('/moderation');
}

