import Link from 'next/link';
import type { ThemeCard as Card } from '@/lib/repo/themes';

export default function ThemeCard({ theme }: { theme: Card }) {
  return (
    <article className="theme-card">
      <div className="thumb">
        {theme.previewMediaId ? (
          // Previews are re-encoded WebP served from our own origin.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/media/${theme.previewMediaId}`} alt={`Preview of the ${theme.title} theme on ${theme.siteName}`} loading="lazy" />
        ) : (
          <div className="noimg">No preview</div>
        )}
      </div>
      <div className="body">
        <h3>
          <Link href={`/themes/${theme.slug}`}>{theme.title}</Link>
        </h3>
        <div className="meta">
          <span>{theme.siteName}</span>
          <span>{theme.appearance === 'mixed' ? 'Light & dark' : theme.appearance === 'dark' ? 'Dark' : 'Light'}</span>
        </div>
        {theme.tags.length > 0 && (
          <div className="chips" aria-label="Tags">
            {theme.tags.slice(0, 3).map((t) => (
              <span key={t} className="badge">{t}</span>
            ))}
          </div>
        )}
        <div className="meta" style={{ marginTop: 'auto' }}>
          <Link href={`/creators/${theme.creator.username}`} className="creator">
            {theme.creator.displayName}
            {theme.creator.official && <span className="badge official" style={{ marginLeft: 6 }}>Official</span>}
          </Link>
          {theme.saveCount > 0 && <span>{theme.saveCount} {theme.saveCount === 1 ? 'save' : 'saves'}</span>}
        </div>
      </div>
    </article>
  );
}
