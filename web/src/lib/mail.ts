import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from './db';

/**
 * Sends the sign-in link. Order of preference:
 *   1. RESEND_API_KEY set  -> sent through Resend's HTTPS API (no extra dependency).
 *   2. development         -> written to the server console and to data/dev-mail/ (NEVER in production).
 *   3. otherwise           -> throws, so sign-in fails loudly instead of silently "sending" nothing.
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function emailDeliveryMode(): 'resend' | 'dev-file' | 'none' {
  if (process.env.RESEND_API_KEY) return 'resend';
  return isProduction() ? 'none' : 'dev-file';
}

export async function sendMail(msg: MailMessage): Promise<void> {
  const mode = emailDeliveryMode();
  if (mode === 'resend') {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM || 'Whimsy Web <onboarding@resend.dev>', to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
    });
    if (!res.ok) throw new Error(`Email provider rejected the message (${res.status}).`);
    return;
  }
  if (mode === 'dev-file') {
    const dir = path.join(dataDir(), 'dev-mail');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${msg.to.replace(/[^a-z0-9@._-]/gi, '_')}.txt`);
    writeFileSync(file, `To: ${msg.to}\nSubject: ${msg.subject}\n\n${msg.text}\n`);
    console.log(`\n[dev mail] To: ${msg.to}\n${msg.text}\n(saved to ${file})\n`);
    return;
  }
  throw new Error('Email delivery is not configured (set RESEND_API_KEY).');
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function signInEmail(to: string, url: string): MailMessage {
  const text = `Sign in to Whimsy Web\n\nOpen this link to sign in (it works once and expires in 15 minutes):\n${url}\n\nIf you did not ask for this, you can ignore this email.`;
  const html = `<p>Sign in to <strong>Whimsy Web</strong></p><p><a href="${escapeHtml(url)}">Open this link to sign in</a> (it works once and expires in 15 minutes).</p><p>If you did not ask for this, you can ignore this email.</p>`;
  return { to, subject: 'Your Whimsy Web sign-in link', text, html };
}
