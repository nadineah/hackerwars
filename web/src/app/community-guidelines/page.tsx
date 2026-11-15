import type { Metadata } from 'next';
import { LegalNotice } from '@/components/LegalNotice';

export const metadata: Metadata = { title: 'Community guidelines' };

export default function Guidelines() {
  return (
    <div className="narrow stack" style={{ margin: '0 auto' }}>
      <h1>Community guidelines</h1>
      <LegalNotice />
      <h2>What you can publish</h2>
      <ul className="stack">
        <li>
          <strong>CSS only.</strong> Themes are style sheets. Scripts, HTML, remote style imports and remote images or fonts are rejected.
        </li>
        <li>
          <strong>Declared websites only.</strong> A theme targets one website from the supported list, and optionally some of its pages. There are no all-site themes.
        </li>
        <li>
          <strong>Your own work.</strong> Publish only styles and screenshots you made or have the right to share, under the license you choose.
        </li>
        <li>
          <strong>Honest previews.</strong> Screenshots must show the real result of the theme.
        </li>
      </ul>
      <h2>What is not allowed</h2>
      <ul className="stack">
        <li>Themes that hide or fake important controls to mislead people (for example, disguising a button’s purpose or hiding warnings).</li>
        <li>Themes meant to harass, impersonate, or phish, or that contain hateful, sexual or illegal content.</li>
        <li>Screenshots that show personal information, yours or anyone else’s: remove usernames, emails and private messages first.</li>
        <li>Sign-in, payment and account-security pages are never supported.</li>
      </ul>
      <h2>Reports and removal</h2>
      <p>
        Anyone can report a theme. Moderators can unpublish a theme and their actions are logged. Unpublished themes can no longer be installed. Themes people already installed are not changed remotely: they can switch them off in the extension.
      </p>
      <p className="muted small">Validation reduces risk but cannot make arbitrary styles harmless. Review what a theme does before you apply it.</p>
    </div>
  );
}
