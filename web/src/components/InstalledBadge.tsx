'use client';

import { useEffect, useState } from 'react';
import type { InstalledTheme } from '../../../theme-core/src';
import { detectExtension, fetchInstalled } from '@/lib/extension-client';

/**
 * Shows whether a theme is installed in THIS browser, but only when the extension itself says so. A saved
 * theme is not an installed theme, and with no extension we show nothing rather than guess.
 */
let cache: Promise<InstalledTheme[] | null> | null = null;
function loadInstalled(extensionIds: string[]): Promise<InstalledTheme[] | null> {
  cache ??= detectExtension(extensionIds).then((d) => (d.found ? fetchInstalled(d.extensionId) : null));
  return cache;
}

export default function InstalledBadge({ themeId, currentVersion, extensionIds }: { themeId: string; currentVersion?: number | null; extensionIds: string[] }) {
  const [info, setInfo] = useState<InstalledTheme | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    loadInstalled(extensionIds).then((list) => alive && setInfo(list ? (list.find((t) => t.themeId === themeId) ?? null) : undefined));
    return () => {
      alive = false;
    };
  }, [themeId, extensionIds]);
  if (!info) return null; // unknown (no extension) or not installed: say nothing
  return (
    <span className="badge" role="status">
      {info.enabled ? 'Active in this browser' : 'Installed, turned off'}
      {currentVersion && info.version < currentVersion ? ` · update available (v${currentVersion})` : ''}
    </span>
  );
}
