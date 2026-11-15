import type { Metadata } from 'next';
import { LegalNotice } from '@/components/LegalNotice';

export const metadata: Metadata = { title: 'Privacy' };

export default function Privacy() {
  return (
    <div className="narrow stack" style={{ margin: '0 auto' }}>
      <h1>Privacy</h1>
      <LegalNotice />
      <h2>What this website stores</h2>
      <ul className="stack">
        <li>
          <strong>Account (only if you sign in):</strong> your email address (kept private, never shown on profiles), a display name, a unique public username, an optional bio and avatar, and which themes you saved.
        </li>
        <li>
          <strong>Themes you publish:</strong> the style sheet, descriptions, screenshots and version history. Published themes and your public profile are visible to everyone. Drafts are visible only to you.
        </li>
        <li>
          <strong>Reports:</strong> the reason and details you enter, and your account if you were signed in.
        </li>
        <li>
          <strong>Abuse limits:</strong> counters per account or per a one-way hash of your network address, used only to rate-limit actions. The address itself is not stored.
        </li>
        <li>
          <strong>Sign-in cookie:</strong> a session cookie so you stay signed in. There are no advertising or analytics cookies.
        </li>
      </ul>
      <h2>What it does not collect</h2>
      <p>
        The website never receives your browsing history, the pages you visit, page contents, cookies, or authentication tokens from the extension. Applying a theme only sends the theme’s id and version between your browser and the extension, and the extension downloads the theme from this site.
      </p>
      <h2>Your choices</h2>
      <p>You can edit your profile, unpublish or delete your themes, and delete your account at any time in Settings. Deleting your account removes your profile, saved themes, themes, screenshots and uploaded files.</p>
      <h2>Email</h2>
      <p>Sign-in emails are sent through the email provider the site owner configures. That provider processes your address to deliver the message.</p>
    </div>
  );
}
