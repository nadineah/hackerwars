import Link from 'next/link';
import type { Metadata } from 'next';
import ThemeCard from '@/components/ThemeCard';
import { galleryFacets, listPublishedThemes } from '@/lib/repo/themes';
import { db } from '@/lib/server';
import { SUPPORTED_SITES, normalizeHostname, supportedSite } from '../../../../theme-core/src';

export const metadata: Metadata = { title: 'Explore themes' };
export const dynamic = 'force-dynamic';

type SP = { q?: string; site?: string; tag?: string; look?: string; sort?: string; page?: string };

function href(sp: SP, over: Partial<SP>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...sp, ...over })) if (v) p.set(k, String(v));
  const s = p.toString();
  return s ? `/explore?${s}` : '/explore';
}

export default async function Explore({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const hostname = sp.site ? (normalizeHostname(sp.site) ?? undefined) : undefined;
  const look = sp.look === 'light' || sp.look === 'dark' || sp.look === 'mixed' ? sp.look : undefined;
  const sort = sp.sort === 'saved' ? 'saved' : 'recent';
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1);
  const result = listPublishedThemes(db(), { q: sp.q, hostname, tag: sp.tag, appearance: look, sort, page, pageSize: 12 });
  const facets = galleryFacets(db());
  const filtered = !!(sp.q || hostname || sp.tag || look);

  return (
    <>
      <h1>Explore themes</h1>
      <form className="filters" method="get" role="search" aria-label="Filter themes">
        <div className="field" style={{ gridColumn: 'span 2' }}>
          <label htmlFor="q">Search</label>
          <input id="q" type="search" name="q" defaultValue={sp.q ?? ''} placeholder="Title, tag, website, creator…" maxLength={80} />
        </div>
        <div className="field">
          <label htmlFor="site">Website</label>
          <select id="site" name="site" defaultValue={hostname ?? ''}>
            <option value="">All websites</option>
            {SUPPORTED_SITES.map((s) => (
              <option key={s.hostname} value={s.hostname}>{s.name}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="look">Appearance</label>
          <select id="look" name="look" defaultValue={look ?? ''}>
            <option value="">Any</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="mixed">Light &amp; dark</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="sort">Sort by</label>
          <select id="sort" name="sort" defaultValue={sort}>
            <option value="recent">Recently added</option>
            <option value="saved">Most saved</option>
          </select>
        </div>
        {sp.tag && <input type="hidden" name="tag" value={sp.tag} />}
        <button className="btn" type="submit">Apply filters</button>
      </form>

      {facets.tags.length > 0 && (
        <div className="chips" style={{ marginBottom: 20 }} aria-label="Popular tags">
          {facets.tags.map((t) => (
            <Link key={t.tag} href={href(sp, { tag: sp.tag === t.tag ? undefined : t.tag, page: undefined })} className="badge" aria-current={sp.tag === t.tag ? 'true' : undefined} style={sp.tag === t.tag ? { background: 'var(--accent)', color: 'var(--accent-ink)' } : undefined}>
              {t.tag} · {t.count}
            </Link>
          ))}
        </div>
      )}

      <p className="muted" role="status">
        {result.total === 0 ? 'No themes match.' : `${result.total} ${result.total === 1 ? 'theme' : 'themes'}`}
        {hostname && ` for ${supportedSite(hostname)?.name ?? hostname}`}
        {filtered && (
          <>
            {' · '}
            <Link href="/explore">Clear filters</Link>
          </>
        )}
      </p>

      {result.items.length > 0 ? (
        <div className="grid">{result.items.map((t) => <ThemeCard key={t.id} theme={t} />)}</div>
      ) : (
        <div className="empty">
          <h2>{filtered ? 'Nothing matches those filters' : 'No themes have been published yet'}</h2>
          <p>{filtered ? 'Try a different search or clear the filters.' : 'Check back soon, or publish the first one.'}</p>
          {filtered ? <Link className="btn secondary" href="/explore">Clear filters</Link> : <Link className="btn" href="/publish">Publish a theme</Link>}
        </div>
      )}

      {result.pages > 1 && (
        <nav className="pagination" aria-label="Pagination">
          {result.page > 1 ? <Link className="btn secondary small" href={href(sp, { page: String(result.page - 1) })}>← Previous</Link> : <span />}
          <span className="muted">Page {result.page} of {result.pages}</span>
          {result.page < result.pages ? <Link className="btn secondary small" href={href(sp, { page: String(result.page + 1) })}>Next →</Link> : <span />}
        </nav>
      )}
    </>
  );
}
