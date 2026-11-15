import type { Metadata } from 'next';
import ThemeForm from '@/components/ThemeForm';
import { extensionIds } from '@/lib/server';
import { requireUserOrRedirect } from '@/lib/session';

export const metadata: Metadata = { title: 'Publish a theme' };
export const dynamic = 'force-dynamic';

export default async function Publish({ searchParams }: { searchParams: Promise<{ draft?: string }> }) {
  const sp = await searchParams;
  const draft = typeof sp.draft === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(sp.draft) ? sp.draft : undefined;
  await requireUserOrRedirect(draft ? `/publish?draft=${draft}` : '/publish');
  return (
    <div className="narrow stack" style={{ margin: '0 auto' }}>
      <h1>Publish a theme</h1>
      <p className="muted">
        Fill in the details and paste or load your CSS. We validate it, then you add screenshots and review before anything becomes public. Please read the <a href="/community-guidelines">community guidelines</a> first.
      </p>
      <ThemeForm importDraftId={draft} extensionIds={extensionIds()} />
    </div>
  );
}
