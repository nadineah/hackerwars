import { THEME_OPTIONS, type ThemeId } from '../shared/types';

const KEY = 'ww-theme';

export const isTheme = (v: unknown): v is ThemeId => THEME_OPTIONS.some((t) => t.id === v);

/**
 * The saved theme is mirrored in localStorage so the panel can apply it synchronously before the
 * first paint (chrome.storage is async, which would flash the default theme on every open).
 */
export function cachedTheme(): ThemeId {
  try {
    const v = localStorage.getItem(KEY);
    return isTheme(v) ? v : 'default';
  } catch {
    return 'default';
  }
}

export function cacheTheme(theme: ThemeId): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* private mode / blocked storage: fine, we just lose the flash-free first paint */
  }
}

export function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme;
}
