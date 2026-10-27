// Chrome/Edge-dependent tests call `chromeOrSkip(t)`: it returns a browser path, or marks the
// test skipped with a reason (reported by node:test, never silent). `DC_TEST_CHROME` overrides.
// The probe list is the service's own discovery (src/service/chrome.ts, docs/SPEC.md §9.5).
// A Snap/Flatpak Chromium cannot read the OS temp folder the tests write designs to: on such a
// machine point DC_TEST_CHROME at a native install (docs/testing/PLATFORMS.md).

import { existsSync } from 'node:fs';
import type { TestContext } from 'node:test';

import { resolveBrowser } from '../../src/service/chrome.ts';

export const findTestBrowser = (): string | null => {
  const override = process.env.DC_TEST_CHROME;
  if (override) return existsSync(override) ? override : null;
  return resolveBrowser({}).path;
};

/** Flags a test's own browser launch needs: Chromium refuses its sandbox as root (Linux containers, CI). */
export const testBrowserFlags = (): string[] => (process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []);

/**
 * A thumbnail of the 1280×800 laptop viewport: 320×200 (THUMB_WIDTH). Chromium on Linux clamps
 * --force-device-scale-factor at 0.5 (measured: Chromium 156, Fedora 44), so there it is 640×400.
 */
export const isLaptopThumbSize = (size: { width?: number; height?: number } | null): boolean =>
  size !== null &&
  ((size.width === 320 && size.height === 200) || (process.platform === 'linux' && size.width === 640 && size.height === 400));

export const chromeOrSkip = (t: TestContext): string | null => {
  const browser = findTestBrowser();
  if (!browser) t.skip('Chrome/Edge/Chromium not found — install one or set DC_TEST_CHROME to run this test.');
  return browser;
};
