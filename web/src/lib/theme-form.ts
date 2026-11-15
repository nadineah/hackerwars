import type { Appearance, LicenseId, PathScope } from '../../../theme-core/src';

/** Plain values shared by the server pages and the client form (kept out of the 'use client' file so both can import it). */
export interface ThemeFormValues {
  title: string;
  hostname: string;
  scopeMode: 'all' | 'prefix' | 'exact';
  scopePaths: string;
  description: string;
  tags: string;
  appearance: Appearance;
  license: LicenseId | '';
  compatNotes: string;
  changeNotes: string;
  css: string;
}

export const EMPTY_VALUES: ThemeFormValues = { title: '', hostname: '', scopeMode: 'all', scopePaths: '', description: '', tags: '', appearance: 'light', license: '', compatNotes: '', changeNotes: '', css: '' };

export const scopeToForm = (s: PathScope): Pick<ThemeFormValues, 'scopeMode' | 'scopePaths'> => (s.mode === 'all' ? { scopeMode: 'all', scopePaths: '' } : { scopeMode: s.mode, scopePaths: s.paths.join('\n') });
