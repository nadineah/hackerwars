import type { Metadata } from 'next';
import Link from 'next/link';
import ThemeForm from '@/components/ThemeForm';
import { extensionIds } from '@/lib/server';
import { requireUserOrRedirect } from '@/lib/session';

export const metadata: Metadata = { title: 'Share a theme' };
export const dynamic = 'force-dynamic';

export default async function Publish({ searchParams }: { searchParams: Promise<{ draft?: string }> }) {
  const sp = await searchParams;
  const draft = typeof sp.draft === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(sp.draft) ? sp.draft : undefined;
  await requireUserOrRedirect(draft ? `/publish?draft=${draft}` : '/publish');
  return (
    <div className="narrow stack" style={{ margin: '0 auto' }}>
      <h1>Share a theme</h1>
      {draft ? (
        <>
          <p className="muted">
            Add a name and a few details, then a screenshot. Nothing is public until you publish. Please read the <Link href="/community-guidelines">community guidelines</Link> first.
          </p>
          <ThemeForm importDraftId={draft} extensionIds={extensionIds()} />
        </>
      ) : (
        <section className="card-surface stack">
          <h2>Themes are shared from the extension</h2>
          <ol className="stack">
            <li>Open a website you restyled with Whimsy Web.</li>
            <li>In the Whimsy Web panel, find your design in the list and press <strong>Share</strong>.</li>
            <li>This page opens with your design attached. Add a name, details and screenshots, then publish.</li>
          </ol>
          <p className="muted small">Do not have the extension yet? <Link href="/install">Get it here</Link>.</p>
        </section>
      )}
    </div>
  );
}
