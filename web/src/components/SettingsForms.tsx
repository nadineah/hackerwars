'use client';

import { useActionState } from 'react';
import { deleteAccountAction, removeAvatarAction, updateProfileAction, uploadAvatarAction } from '@/app/actions';

function Msg({ state }: { state: { error?: string; ok?: string } | null }) {
  return (
    <>
      {state?.error && (
        <div className="alert error" role="alert">
          {state.error}
        </div>
      )}
      {state?.ok && (
        <div className="alert ok" role="status">
          {state.ok}
        </div>
      )}
    </>
  );
}

export function ProfileForm({ username, displayName, bio }: { username: string; displayName: string; bio: string }) {
  const [state, action, pending] = useActionState(updateProfileAction, null);
  return (
    <form action={action} className="stack">
      <div className="field">
        <label htmlFor="displayName">Display name</label>
        <input id="displayName" name="displayName" defaultValue={displayName} required maxLength={40} aria-invalid={state?.field === 'displayName'} />
      </div>
      <div className="field">
        <label htmlFor="username">Public username</label>
        <input id="username" name="username" defaultValue={username} required maxLength={24} pattern="[A-Za-z0-9_\-]{3,24}" aria-describedby="username-hint" aria-invalid={state?.field === 'username'} />
        <p className="hint" id="username-hint">
          3 to 24 letters, numbers, dashes or underscores. Your profile address is /creators/username.
        </p>
      </div>
      <div className="field">
        <label htmlFor="bio">Short bio</label>
        <textarea id="bio" name="bio" defaultValue={bio} maxLength={280} style={{ minHeight: 90 }} />
      </div>
      <Msg state={state} />
      <div>
        <button className="btn" disabled={pending}>
          {pending ? 'Saving…' : 'Save profile'}
        </button>
      </div>
    </form>
  );
}

export function AvatarForm({ hasAvatar }: { hasAvatar: boolean }) {
  const [state, action, pending] = useActionState(uploadAvatarAction, null);
  return (
    <div className="stack">
      <form action={action} className="stack">
        <div className="field">
          <label htmlFor="avatar">Avatar image</label>
          <input id="avatar" name="avatar" type="file" accept="image/png,image/jpeg,image/webp" required />
          <p className="hint">PNG, JPEG or WebP, up to 6 MB. It is resized and stripped of metadata. SVG is not accepted.</p>
        </div>
        <Msg state={state} />
        <div className="row">
          <button className="btn secondary" disabled={pending}>
            {pending ? 'Uploading…' : 'Upload avatar'}
          </button>
        </div>
      </form>
      {hasAvatar && (
        <form action={removeAvatarAction}>
          <button className="btn secondary small" type="submit">
            Remove avatar
          </button>
        </form>
      )}
    </div>
  );
}

export function DeleteAccountForm() {
  const [state, action, pending] = useActionState(deleteAccountAction, null);
  return (
    <details>
      <summary>Delete my account</summary>
      <form action={action} className="stack" style={{ marginTop: 12 }}>
        <p>This permanently removes your profile, saved themes, all themes you published, their screenshots and your uploads. It cannot be undone. Themes other people already installed keep working in their browsers.</p>
        <div className="field">
          <label htmlFor="confirm">Type “delete” to confirm</label>
          <input id="confirm" name="confirm" autoComplete="off" required />
        </div>
        <Msg state={state} />
        <div>
          <button className="btn danger" disabled={pending}>
            {pending ? 'Deleting…' : 'Delete account permanently'}
          </button>
        </div>
      </form>
    </details>
  );
}
