import Link from 'next/link';

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="container">
        <span>WhimsyWeb: make the internet yours.</span>
        <nav aria-label="Footer">
          <Link href="/install">Install the extension</Link>
          <Link href="/community-guidelines">Community guidelines</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </nav>
      </div>
    </footer>
  );
}
