import { PROTOCOL, isExtError, type ExtRequest, type ExtResponse, type InstalledTheme, type PingResponse } from '../../../theme-core/src';

/**
 * Browser-side helper for talking to the Whimsy Web extension. Runs only in the visitor's browser.
 * It never assumes success: every call has a timeout, and "no extension" is a normal, handled outcome.
 */

interface ChromeRuntime {
  sendMessage: (id: string, msg: unknown, cb: (r: unknown) => void) => void;
  lastError?: { message?: string };
}
const runtime = (): ChromeRuntime | null => {
  const c = (globalThis as { chrome?: { runtime?: ChromeRuntime } }).chrome;
  return c?.runtime && typeof c.runtime.sendMessage === 'function' ? c.runtime : null;
};

/** True if this browser exposes extension messaging to web pages (Chromium-based browsers). */
export const canMessageExtensions = (): boolean => runtime() !== null;

export async function sendToExtension(extensionId: string, msg: ExtRequest, timeoutMs = 4000): Promise<ExtResponse | { ok: false; code: 'timeout' | 'no-extension'; message: string }> {
  const rt = runtime();
  if (!rt) return { ok: false, code: 'no-extension', message: 'This browser cannot talk to extensions from a web page.' };
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, code: 'timeout', message: 'The extension did not answer in time.' }), timeoutMs);
    try {
      rt.sendMessage(extensionId, msg, (response) => {
        clearTimeout(timer);
        // lastError is set when the extension is not installed / not reachable from this origin.
        if (rt.lastError) {
          void rt.lastError.message; // reading it clears the "unchecked runtime.lastError" warning
          resolve({ ok: false, code: 'no-extension', message: 'The Whimsy Web extension was not found.' });
        } else if (response && typeof response === 'object') {
          resolve(response as ExtResponse);
        } else {
          resolve({ ok: false, code: 'timeout', message: 'The extension gave an empty answer.' });
        }
      });
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, code: 'no-extension', message: e instanceof Error ? e.message : 'Could not reach the extension.' });
    }
  });
}

export type Detection =
  | { found: true; extensionId: string; ping: PingResponse }
  | { found: false; reason: 'unsupported-browser' | 'not-configured' | 'not-installed' | 'incompatible'; message: string };

/** Tries each configured extension id and returns the first that answers a valid ping. */
export async function detectExtension(extensionIds: string[]): Promise<Detection> {
  if (!canMessageExtensions()) return { found: false, reason: 'unsupported-browser', message: 'Use a Chromium-based browser (Chrome, Edge, Brave, Arc) to apply themes.' };
  if (extensionIds.length === 0) return { found: false, reason: 'not-configured', message: 'This site is not configured with an extension id yet.' };
  for (const id of extensionIds) {
    const r = await sendToExtension(id, { type: 'whimsyweb:ping', protocol: PROTOCOL }, 2500);
    if (r.ok && 'extensionVersion' in r) {
      if (r.protocol !== PROTOCOL) return { found: false, reason: 'incompatible', message: 'Your extension speaks a different version. Please update it.' };
      return { found: true, extensionId: id, ping: r };
    }
  }
  return { found: false, reason: 'not-installed', message: 'The Whimsy Web extension was not detected in this browser.' };
}

export async function fetchInstalled(extensionId: string): Promise<InstalledTheme[]> {
  const r = await sendToExtension(extensionId, { type: 'whimsyweb:installed', protocol: PROTOCOL });
  return r.ok && 'themes' in r ? r.themes : [];
}

export { isExtError };
