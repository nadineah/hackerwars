import { notFound } from 'next/navigation';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from '@/lib/db';
import { isProduction } from '@/lib/mail';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Dev mailbox', robots: { index: false } };

/** DEVELOPMENT ONLY: shows sign-in links that would have been emailed. Returns 404 in production. */
export default function DevMail() {
  if (isProduction() || process.env.RESEND_API_KEY) notFound();
  const dir = path.join(dataDir(), 'dev-mail');
  const files = existsSync(dir) ? readdirSync(dir).sort().reverse().slice(0, 10) : [];
  return (
    <div className="narrow" style={{ margin: '0 auto' }}>
      <h1>Dev mailbox</h1>
      <p className="alert warn">Development only. This page does not exist in production builds.</p>
      {files.length === 0 && <p className="muted">No messages yet.</p>}
      {files.map((f) => {
        const text = readFileSync(path.join(dir, f), 'utf8');
        const url = text.match(/https?:\/\/\S+/)?.[0];
        return (
          <div key={f} className="card-surface" style={{ marginBottom: 12 }}>
            <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{text.split('\n').slice(0, 2).join('\n')}</pre>
            {url && <p><a className="btn small" href={url}>Open sign-in link</a></p>}
          </div>
        );
      })}
    </div>
  );
}
