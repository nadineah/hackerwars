'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { createDraftAction, saveThemeAction } from '@/app/actions';
import { detectExtension, sendToExtension, isExtError } from '@/lib/extension-client';
import { EMPTY_VALUES, scopeToForm, type ThemeFormValues } from '@/lib/theme-form';
import { LICENSES, LIMITS, PROTOCOL, SUPPORTED_SITES, type Appearance, type LicenseId } from '../../../theme-core/src';

interface Props {
  /** Present when editing an existing theme. */
  themeId?: string;
  initial?: Partial<ThemeFormValues>;
  /** A draft the extension prepared; fetched from the extension, never from the URL. */
  importDraftId?: string;
  extensionIds?: string[];
  lockHostname?: boolean;
}

export default function ThemeForm({ themeId, initial, importDraftId, extensionIds = [], lockHostname }: Props) {
  const [v, setV] = useState<ThemeFormValues>({ ...EMPTY_VALUES, ...initial });
  const [state, action, pending] = useActionState(themeId ? saveThemeAction : createDraftAction, null);
  const [importMsg, setImportMsg] = useState<{ kind: 'info' | 'error'; text: string } | null>(importDraftId ? { kind: 'info', text: 'Fetching your theme from the extension…' } : null);
  const imported = useRef(false);
  const set = <K extends keyof ThemeFormValues>(k: K, val: ThemeFormValues[K]) => setV((x) => ({ ...x, [k]: val }));
  const bad = (f: string) => state?.field === f;

  // Extension -> website draft transfer: the website asks the extension for the draft by its one-time id.
  useEffect(() => {
    if (!importDraftId || imported.current) return;
    imported.current = true;
    (async () => {
      const found = await detectExtension(extensionIds);
      if (!found.found) {
        setImportMsg({ kind: 'error', text: `${found.message} Make sure the extension is loaded from the latest build (reload it at chrome://extensions), and that you opened this site at ${location.origin}, then press Share again.` });
        return;
      }
      const r = await sendToExtension(found.extensionId, { type: 'whimsyweb:get-draft', protocol: PROTOCOL, draftId: importDraftId });
      if (r.ok && 'draft' in r) {
        const d = r.draft;
        const known = SUPPORTED_SITES.some((s) => s.hostname === d.hostname);
        setV((x) => ({ ...x, title: d.title.slice(0, LIMITS.titleChars), hostname: known ? d.hostname : '', css: d.css, appearance: d.appearance ?? x.appearance, ...scopeToForm(d.pathScope) }));
        setImportMsg({ kind: known ? 'info' : 'error', text: known ? 'Imported from your extension. Review the details before saving: nothing has been published.' : `Imported your design, but ${d.hostname} is not on the supported list, so pick a website below.` });
        return;
      }
      setImportMsg({ kind: 'error', text: isExtError(r) && r.code === 'not-found' ? 'That share link has expired or was already used. Press Share in the extension again.' : `The extension answered but could not hand over your design (${'message' in r ? r.message : 'unknown problem'}). Press Share again.` });
    })();
  }, [importDraftId, extensionIds]);

  async function readFile(f: File | undefined) {
    if (!f) return;
    if (f.size > LIMITS.cssBytes * 2) return setImportMsg({ kind: 'error', text: `That file is larger than ${Math.round((LIMITS.cssBytes * 2) / 1000)} KB.` });
    set('css', await f.text());
    setImportMsg({ kind: 'info', text: `Loaded ${f.name}. It is validated when you save.` });
  }

  return (
    <form action={action} className="stack" style={{ gap: 22 }}>
      {themeId && <input type="hidden" name="themeId" value={themeId} />}
      {importMsg && (
        <div className={`alert ${importMsg.kind === 'error' ? 'error' : 'info'}`} role="status">
          {importMsg.text}
        </div>
      )}

      <fieldset className="card-surface stack">
        <legend>1 · Name and website</legend>
        <div className="field">
          <label htmlFor="title">Theme name</label>
          <input id="title" name="title" required maxLength={LIMITS.titleChars} value={v.title} onChange={(e) => set('title', e.target.value)} aria-invalid={bad('title')} />
        </div>
        <div className="field">
          <label htmlFor="hostname">Target website</label>
          {lockHostname ? (
            <>
              <input type="hidden" name="hostname" value={v.hostname} />
              <input id="hostname" value={SUPPORTED_SITES.find((s) => s.hostname === v.hostname)?.name ?? v.hostname} disabled />
              <p className="hint">The website of a theme cannot be changed. Create a new theme for another site.</p>
            </>
          ) : (
            <select id="hostname" name="hostname" required value={v.hostname} onChange={(e) => set('hostname', e.target.value)} aria-invalid={bad('hostname')}>
              <option value="" disabled>
                Choose a website…
              </option>
              {SUPPORTED_SITES.map((s) => (
                <option key={s.hostname} value={s.hostname}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
          <p className="hint">Themes can only target the supported websites. Sign-in, payment and account-security pages are never supported.</p>
        </div>
      </fieldset>

      <fieldset className="card-surface stack">
        <legend>2 · Which pages</legend>
        <div className="field">
          <label htmlFor="scopeMode">Applies to</label>
          <select id="scopeMode" name="scopeMode" value={v.scopeMode} onChange={(e) => set('scopeMode', e.target.value as ThemeFormValues['scopeMode'])}>
            <option value="all">The whole website</option>
            <option value="prefix">These paths and everything below them</option>
            <option value="exact">Only these exact pages</option>
          </select>
        </div>
        {v.scopeMode !== 'all' && (
          <div className="field">
            <label htmlFor="scopePaths">Paths (one per line)</label>
            <textarea id="scopePaths" name="scopePaths" value={v.scopePaths} onChange={(e) => set('scopePaths', e.target.value)} placeholder={'/wiki\n/w/index.php'} style={{ minHeight: 90 }} aria-invalid={bad('scope')} />
            <p className="hint">Start each with “/”. Up to {LIMITS.pathScopePaths}. “/wiki” also covers “/wiki/Cat” but not “/wikipedia”.</p>
          </div>
        )}
      </fieldset>

      <fieldset className="card-surface stack">
        <legend>3 · Details</legend>
        <div className="field">
          <label htmlFor="description">Description</label>
          <textarea id="description" name="description" value={v.description} onChange={(e) => set('description', e.target.value)} maxLength={LIMITS.descriptionChars} style={{ minHeight: 90 }} />
        </div>
        <div className="field">
          <label htmlFor="tags">Tags</label>
          <input id="tags" name="tags" value={v.tags} onChange={(e) => set('tags', e.target.value)} placeholder="cozy, serif, minimal" />
          <p className="hint">Comma separated. Up to {LIMITS.tags} tags describing the look, such as “cozy” or “high contrast”.</p>
        </div>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div className="field grow">
            <label htmlFor="appearance">Appearance</label>
            <select id="appearance" name="appearance" value={v.appearance} onChange={(e) => set('appearance', e.target.value as Appearance)}>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
              <option value="mixed">Light and dark</option>
            </select>
          </div>
          <div className="field grow">
            <label htmlFor="license">License</label>
            <select id="license" name="license" required value={v.license} onChange={(e) => set('license', e.target.value as LicenseId)} aria-invalid={bad('license')}>
              <option value="" disabled>
                Choose a license…
              </option>
              {LICENSES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="compatNotes">Compatibility notes</label>
          <textarea id="compatNotes" name="compatNotes" value={v.compatNotes} onChange={(e) => set('compatNotes', e.target.value)} maxLength={400} style={{ minHeight: 70 }} placeholder="Which pages you tested, and anything that does not look right." />
        </div>
      </fieldset>

      <fieldset className="card-surface stack">
        <legend>4 · Your design</legend>
        <input type="hidden" name="css" value={v.css} />
        {v.css ? (
          <div className="alert ok" role="status">
            {themeId ? 'Your design is attached.' : 'Your design came from the Whimsy Web extension and is attached.'} It is checked for safety when you save.
          </div>
        ) : (
          <div className="alert warn" role="alert">
            No design attached yet. Open the Whimsy Web extension on the website you restyled and press <strong>Share</strong> next to your design.
          </div>
        )}
        {themeId && (
          <details>
            <summary>Advanced: edit the design code</summary>
            <div className="field" style={{ marginTop: 10 }}>
              <label htmlFor="css-adv">Design code (CSS)</label>
              <textarea id="css-adv" value={v.css} onChange={(e) => set('css', e.target.value)} spellCheck={false} style={{ minHeight: 220, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.85rem' }} aria-invalid={bad('css')} />
              <p className="hint">For people who know CSS. Up to {LIMITS.cssBytes / 1000} KB; no imports, remote images, fonts or scripts.</p>
            </div>
          </details>
        )}
        <div className="field">
          <label htmlFor="changeNotes">{themeId ? 'What changed in this version' : 'Notes for the first version (optional)'}</label>
          <input id="changeNotes" name="changeNotes" value={v.changeNotes} onChange={(e) => set('changeNotes', e.target.value)} maxLength={LIMITS.changeNotesChars} />
        </div>
      </fieldset>

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
      <div className="row">
        <button className="btn" disabled={pending || !v.css}>
          {pending ? 'Saving…' : themeId ? 'Save changes' : 'Save draft and continue'}
        </button>
        {!themeId && <span className="hint">Next you add preview screenshots and publish. Nothing is public until you publish.</span>}
      </div>
    </form>
  );
}
