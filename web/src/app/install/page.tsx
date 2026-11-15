import Link from 'next/link';
import type { Metadata } from 'next';
import ExtensionStatus from '@/components/ExtensionStatus';
import { extensionIds } from '@/lib/server';

export const metadata: Metadata = { title: 'Get the extension' };
export const dynamic = 'force-dynamic';

export default async function Install({ searchParams }: { searchParams: Promise<{ theme?: string }> }) {
  const sp = await searchParams;
  const theme = typeof sp.theme === 'string' && /^[a-z0-9-]{1,80}$/.test(sp.theme) ? sp.theme : null;
  const store = process.env.EXTENSION_STORE_URL;
  return (
    <div className="narrow stack" style={{ margin: '0 auto' }}>
      <h1>Get the WhimsyWeb extension</h1>
      <p className="muted">Themes from this site are applied by the WhimsyWeb browser extension. The website never changes other websites by itself.</p>
      <ExtensionStatus extensionIds={extensionIds()} />
      {theme && (
        <div className="alert info" role="status">
          You were applying a theme. Once the extension is installed, <Link href={`/themes/${theme}`}>go back to it</Link> and press “Apply theme”.
        </div>
      )}
      <section className="card-surface stack" aria-labelledby="chrome">
        <h2 id="chrome">Chrome, Edge, Brave and other Chromium browsers</h2>
        {store ? (
          <p>
            <a className="btn" href={store} rel="noopener">
              Add to your browser
            </a>
          </p>
        ) : (
          <p className="muted small">Not installed yet? The extension is not in a browser store yet, so install it from the project files (steps below).</p>
        )}
        <ol className="stack">
          <li>
            Build the extension: run <code>npm install</code> then <code>npm run build</code> in the project folder. This creates a <code>dist</code> folder.
          </li>
          <li>
            Open <code>chrome://extensions</code> and turn on <strong>Developer mode</strong>.
          </li>
          <li>
            Choose <strong>Load unpacked</strong> and select the <code>dist</code> folder.
          </li>
          <li>
            Come back to a theme page and press <strong>Apply theme</strong>.
          </li>
        </ol>
      </section>
      <section className="card-surface stack" aria-labelledby="what">
        <h2 id="what">What happens when you apply a theme</h2>
        <ul className="stack">
          <li>The extension downloads that exact theme version from this site and checks it again itself.</li>
          <li>It asks you to confirm, naming the website it will change.</li>
          <li>You can turn it off or restore the previous look at any time from the extension.</li>
          <li>This site only learns what you choose to send: it never receives your browsing history, page contents, cookies or tokens.</li>
        </ul>
      </section>
      <p className="muted small">Firefox and Safari are not supported yet.</p>
    </div>
  );
}
