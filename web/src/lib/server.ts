import { openDb, type Db } from './db';

/** The app's database (opened and migrated once per process). */
export const db = (): Db => openDb();

export const siteUrl = (): string => (process.env.SITE_URL || 'http://localhost:3000').replace(/\/+$/, '');

const list = (v: string | undefined): string[] => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
export const moderatorEmails = (): string[] => list(process.env.MODERATOR_EMAILS);

/** Browser-extension ids allowed to talk to this site (and that this site tells visitors to talk to). */
export const extensionIds = (): string[] => list(process.env.EXTENSION_IDS);
