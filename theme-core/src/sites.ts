/**
 * The curated list of websites themes may target in the MVP. Creators choose from this list rather than
 * typing any hostname. Deliberately excludes banking, payments, email, and authentication surfaces, and
 * every theme additionally refuses sign-in / security / checkout paths (see isSensitivePath).
 *
 * Adding a site here is a deliberate product decision, not a user input.
 */
export interface SupportedSite {
  hostname: string;
  name: string;
  /** Plain-language compatibility note shown on theme pages. */
  note: string;
}

export const SUPPORTED_SITES: SupportedSite[] = [
  { hostname: 'en.wikipedia.org', name: 'Wikipedia (English)', note: 'Article and search pages. Other language editions are separate sites and are not covered.' },
  { hostname: 'news.ycombinator.com', name: 'Hacker News', note: 'Front page, comment threads and user pages.' },
  { hostname: 'github.com', name: 'GitHub', note: 'Repository and issue pages; GitHub changes its markup often, so themes may need updates.' },
  { hostname: 'www.reddit.com', name: 'Reddit', note: 'Reddit redesigns frequently and some views use custom elements; themes may need updates.' },
  { hostname: 'www.youtube.com', name: 'YouTube', note: 'YouTube is a single-page app that changes often; themes may need updates.' },
  { hostname: 'www.pinterest.com', name: 'Pinterest', note: 'Pinterest uses generated class names; themes may need updates.' },
];

export const supportedSite = (hostname: string): SupportedSite | undefined =>
  SUPPORTED_SITES.find((s) => s.hostname === hostname);
