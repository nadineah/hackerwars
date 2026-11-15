import Link from 'next/link';
import type { Metadata } from 'next';
import { emailDeliveryMode } from '@/lib/mail';

export const metadata: Metadata = { title: 'Check your email' };

export default async function CheckEmail({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const sp = await searchParams;
  return (
    <div className="narrow" style={{ margin: '0 auto' }}>
      <h1>Check your email</h1>
      <p>
        We sent a sign-in link{sp.email ? <> to <strong>{sp.email}</strong></> : ''}. It works once and expires in 15 minutes. If it does not
        arrive, check your spam folder or <Link href="/sign-in">request another</Link>.
      </p>
      {emailDeliveryMode() === 'dev-file' && (
        <p className="alert info">Development mode: open <Link href="/dev/mail">/dev/mail</Link> to read the link (no real email is sent).</p>
      )}
    </div>
  );
}
