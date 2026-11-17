import type { Metadata } from 'next';
import { LegalNotice } from '@/components/LegalNotice';

export const metadata: Metadata = { title: 'Terms' };

export default function Terms() {
  return (
    <div className="narrow stack" style={{ margin: '0 auto' }}>
      <h1>Terms of use</h1>
      <LegalNotice />
      <ul className="stack">
        <li>
          <strong>Themes are provided as is.</strong> Websites change, so a theme may stop working or look different. Compatibility notes on each theme describe what was checked.
        </li>
        <li>
          <strong>You own what you publish</strong> and you grant the license you select on the theme. By publishing you confirm you have the right to share the style sheet and screenshots.
        </li>
        <li>
          <strong>Moderation.</strong> We may unpublish themes or remove accounts that break the community guidelines.
        </li>
        <li>
          <strong>Third-party websites</strong> are not affiliated with Whimsy Web. Themes only change how a page looks in your own browser.
        </li>
      </ul>
      <p className="muted small">Contact details, governing law and liability wording must be added by the site owner.</p>
    </div>
  );
}
