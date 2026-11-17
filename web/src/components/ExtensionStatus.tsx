'use client';

import { useEffect, useState } from 'react';
import { detectExtension, type Detection } from '@/lib/extension-client';

/** Tells the visitor whether the extension is actually reachable from this page right now. */
export default function ExtensionStatus({ extensionIds }: { extensionIds: string[] }) {
  const [d, setD] = useState<Detection | 'checking'>('checking');
  useEffect(() => {
    detectExtension(extensionIds).then(setD);
  }, [extensionIds]);
  if (d === 'checking') return <div className="alert info" role="status">Checking for the extension…</div>;
  if (d.found) return <div className="alert ok" role="status">The Whimsy Web extension is installed and working in this browser (version {d.ping.extensionVersion}). You can apply themes now.</div>;
  return (
    <div className="alert warn" role="status">
      {d.message} If you just loaded it, reload the extension at chrome://extensions and refresh this page.
    </div>
  );
}
