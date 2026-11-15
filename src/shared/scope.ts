import { pathInScope } from '../../theme-core/src/scope';
import type { Design, DesignScope } from './types';

/** Designs for "all sites" live in the same storage layout as a site, under this pseudo-host. */
export const GLOBAL_HOST = '*';

/** "/watch/" and "/watch" are the same page; the query string and hash are ignored. */
export const normalizePath = (p: string): string => p.replace(/\/+$/, '') || '/';

/** Designs saved before scopes existed are site-wide. */
export const scopeOf = (d: Pick<Design, 'scope'>): DesignScope => d.scope ?? 'site';

/**
 * A "slot" is a place a design can live. At most one design is enabled per slot: one for all sites,
 * one site-wide design per site, plus one per page. Designs in different slots can be on together.
 */
export const slotOf = (d: Pick<Design, 'scope' | 'path'>): string => {
  const scope = scopeOf(d);
  return scope === 'global' ? 'global' : scope === 'page' ? `page:${normalizePath(d.path ?? '/')}` : 'site';
};

/** Stacking order: all-sites at the bottom, then the site, then the page on top. */
export const layerOf = (d: Pick<Design, 'scope'>): number => {
  const scope = scopeOf(d);
  return scope === 'global' ? 0 : scope === 'site' ? 1 : 2;
};

/** Does the design's SCOPE cover this path? (Host and exclusions are checked by `appliesOn`.) */
export const appliesTo = (d: Pick<Design, 'scope' | 'path' | 'community'>, path: string): boolean =>
  // Community themes declare their own pages (and never cover sign-in, security or payment pages).
  d.community ? pathInScope(path, d.community.pathScope) : scopeOf(d) !== 'page' || normalizePath(d.path ?? '/') === normalizePath(path);

/** Should this design be applied on `host` + `path`? All-sites designs honor per-site exclusions. */
export const appliesOn = (
  d: Pick<Design, 'scope' | 'path' | 'host' | 'excludedHosts' | 'community'>,
  host: string,
  path: string,
): boolean =>
  scopeOf(d) === 'global' ? !(d.excludedHosts ?? []).includes(host) : d.host === host && appliesTo(d, path);

export const scopeLabel = (d: Pick<Design, 'scope' | 'path'>): string => {
  const scope = scopeOf(d);
  return scope === 'global' ? 'All sites' : scope === 'page' ? `Page · ${normalizePath(d.path ?? '/')}` : 'Whole site';
};
