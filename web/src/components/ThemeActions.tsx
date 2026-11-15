'use client';

import { useActionState } from 'react';
import { deleteThemeAction, publishAction, removePreviewAction, republishAction, unpublishAction, uploadPreviewAction } from '@/app/actions';

const Msg = ({ s }: { s: { error?: string; ok?: string } | null }) => (
  <>
    {s?.error && (
      <div className="alert error" role="alert">
        {s.error}
      </div>
    )}
    {s?.ok && (
      <div className="alert ok" role="status">
        {s.ok}
      </div>
    )}
  </>
);

export function PreviewUpload({ themeId, siteName }: { themeId: string; siteName: string }) {
  const [state, action, pending] = useActionState(uploadPreviewAction, null);
  return (
    <form action={action} className="stack">
      <input type="hidden" name="themeId" value={themeId} />
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="field">
          <label htmlFor="role">Which screenshot</label>
          <select id="role" name="role" defaultValue="after">
            <option value="before">Before (without the theme)</option>
            <option value="after">After (with the theme)</option>
            <option value="extra">Extra</option>
          </select>
        </div>
        <div className="field grow">
          <label htmlFor="image">Image</label>
          <input id="image" name="image" type="file" accept="image/png,image/jpeg,image/webp" required />
        </div>
      </div>
      <div className="field">
        <label htmlFor="alt">Describe the image (alt text)</label>
        <input id="alt" name="alt" maxLength={160} placeholder={`${siteName} with this theme`} />
      </div>
      <p className="hint">PNG, JPEG or WebP up to 6 MB; it is re-encoded and metadata is removed. Before uploading, remove anything personal from the screenshot: usernames, email addresses, private messages.</p>
      <Msg s={state} />
      <div>
        <button className="btn secondary" disabled={pending}>
          {pending ? 'Uploading…' : 'Add screenshot'}
        </button>
      </div>
    </form>
  );
}

export function RemovePreview({ themeId, previewId, label }: { themeId: string; previewId: string; label: string }) {
  return (
    <form action={removePreviewAction.bind(null, themeId, previewId)}>
      <button className="btn secondary small" type="submit" aria-label={`Remove ${label} screenshot`}>
        Remove
      </button>
    </form>
  );
}

export function PublishForm({ themeId, problems, isUpdate }: { themeId: string; problems: string[]; isUpdate: boolean }) {
  const [state, action, pending] = useActionState(publishAction, null);
  return (
    <form action={action} className="stack">
      <input type="hidden" name="themeId" value={themeId} />
      {problems.length > 0 && (
        <div className="alert warn problems">
          <strong>Before you can publish:</strong>
          <ul>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      <label className="check">
        <input type="checkbox" name="permission" required />
        <span>I made this theme and its screenshots or have the right to share them, they contain no personal information, and I accept the community guidelines.</span>
      </label>
      {isUpdate && <p className="hint">Publishing creates a new version. People who already installed an earlier version keep it until they choose to update.</p>}
      <Msg s={state} />
      <div>
        <button className="btn" disabled={pending || problems.length > 0}>
          {pending ? 'Publishing…' : isUpdate ? 'Publish new version' : 'Publish theme'}
        </button>
      </div>
    </form>
  );
}

export function VisibilityButtons({ themeId, status, byModerator }: { themeId: string; status: string; byModerator: boolean }) {
  if (status === 'published')
    return (
      <form action={unpublishAction.bind(null, themeId)}>
        <button className="btn secondary small" type="submit">
          Unpublish
        </button>
      </form>
    );
  if (status === 'unpublished' && !byModerator)
    return (
      <form action={republishAction.bind(null, themeId)}>
        <button className="btn secondary small" type="submit">
          Republish
        </button>
      </form>
    );
  return null;
}

export function DeleteThemeForm({ themeId }: { themeId: string }) {
  const [state, action, pending] = useActionState(deleteThemeAction, null);
  return (
    <details>
      <summary>Delete this theme</summary>
      <form action={action} className="stack" style={{ marginTop: 12 }}>
        <input type="hidden" name="themeId" value={themeId} />
        <p>This permanently removes the theme, all versions and screenshots. People who already installed it keep their copy in their own browsers.</p>
        <div className="field">
          <label htmlFor="del">Type “delete” to confirm</label>
          <input id="del" name="confirm" autoComplete="off" required />
        </div>
        <Msg s={state} />
        <div>
          <button className="btn danger" disabled={pending}>
            Delete theme permanently
          </button>
        </div>
      </form>
    </details>
  );
}
