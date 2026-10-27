import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { browserCandidates, resolveBrowser } from '../../../src/service/chrome.ts';

describe('resolveBrowser', () => {
  test('the configured path wins when it exists (source: setting)', () => {
    const result = resolveBrowser({ chromePath: 'C:\\Custom\\chrome.exe' }, () => true);
    assert.deepEqual(result, { path: 'C:\\Custom\\chrome.exe', source: 'setting' });
  });

  test('a configured path that no longer exists falls through to detection', () => {
    const probed: string[] = [];
    const result = resolveBrowser(
      { chromePath: 'C:\\Gone\\chrome.exe' },
      (candidate) => {
        probed.push(candidate);
        return probed.length > 1 && candidate.includes('Edge');
      },
      { platform: 'win32', env: {} },
    );
    assert.equal(result.source, 'detected');
    assert.ok(result.path?.includes('Edge'), `detected ${result.path}`);
    assert.equal(probed[0], 'C:\\Gone\\chrome.exe', 'the setting is probed first');
  });

  test('no browser anywhere → none (thumbnails become unavailable)', () => {
    assert.deepEqual(resolveBrowser({}, () => false), { path: null, source: 'none' });
    assert.deepEqual(resolveBrowser({ chromePath: '' }, () => false), { path: null, source: 'none' });
  });

  const probedOn = (host: Parameters<typeof browserCandidates>[0]): string[] => {
    const probed: string[] = [];
    resolveBrowser(
      {},
      (candidate) => {
        probed.push(candidate);
        return false;
      },
      host,
    );
    return probed;
  };

  test('win32 probes literal install paths (no ProgramFiles env in the service, F9), Chrome before Edge', () => {
    const local = 'C:\\Users\\you\\AppData\\Local';
    const probed = probedOn({ platform: 'win32', env: { LOCALAPPDATA: local } });
    assert.ok(probed.includes('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'));
    assert.ok(probed.includes('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'));
    assert.ok(probed.includes(`${local}\\Google\\Chrome\\Application\\chrome.exe`));
    assert.ok(probed.some((candidate) => candidate.endsWith('Microsoft\\Edge\\Application\\msedge.exe')));
    const firstChrome = probed.findIndex((candidate) => candidate.includes('Chrome'));
    const firstEdge = probed.findIndex((candidate) => candidate.includes('Edge'));
    assert.ok(firstChrome < firstEdge, 'Chrome is preferred over Edge');
    assert.equal(probedOn({ platform: 'win32', env: {} }).some((candidate) => candidate.includes('AppData')), false, 'no LOCALAPPDATA → no per-user probe');
  });

  test('darwin probes each app bundle in /Applications, then ~/Applications, Chrome first', () => {
    const probed = probedOn({ platform: 'darwin', homeDir: '/Users/you' });
    assert.equal(probed[0], '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    assert.equal(probed[1], '/Users/you/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    for (const app of ['Google Chrome Canary', 'Chromium', 'Microsoft Edge', 'Brave Browser']) {
      assert.ok(probed.includes(`/Applications/${app}.app/Contents/MacOS/${app}`), app);
      assert.ok(probed.includes(`/Users/you/Applications/${app}.app/Contents/MacOS/${app}`), `~ ${app}`);
    }
  });

  test('linux probes PATH first, then /usr/bin and /usr/local/bin, then Snap and Flatpak launchers', () => {
    const probed = probedOn({ platform: 'linux', env: { PATH: '/home/you/bin:/usr/bin:relative/ignored' }, homeDir: '/home/you' });
    assert.equal(probed[0], '/home/you/bin/google-chrome', 'PATH order: the first name in the first PATH folder');
    for (const name of ['google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser']) {
      assert.ok(probed.includes(`/usr/bin/${name}`), name);
      assert.ok(probed.includes(`/usr/local/bin/${name}`), `local ${name}`);
    }
    assert.ok(!probed.some((candidate) => candidate.startsWith('relative')), 'a relative PATH entry is never probed');
    assert.equal(new Set(probed).size, probed.length, 'no candidate is probed twice (/usr/bin is on PATH and literal)');
    for (const sandboxed of [
      '/snap/bin/chromium',
      '/var/lib/flatpak/exports/bin/com.google.Chrome',
      '/var/lib/flatpak/exports/bin/org.chromium.Chromium',
      '/home/you/.local/share/flatpak/exports/bin/com.google.Chrome',
      '/home/you/.local/share/flatpak/exports/bin/org.chromium.Chromium',
    ]) {
      assert.ok(probed.includes(sandboxed), sandboxed);
    }
    const lastNative = probed.findIndex((candidate) => candidate === '/usr/local/bin/brave-browser');
    assert.ok(lastNative < probed.indexOf('/snap/bin/chromium'), 'native installs are preferred over Snap/Flatpak');

    // A minimal service PATH still finds a system install.
    const found = resolveBrowser({}, (candidate) => candidate === '/usr/bin/chromium', { platform: 'linux', env: { PATH: '' }, homeDir: '/home/you' });
    assert.deepEqual(found, { path: '/usr/bin/chromium', source: 'detected' });
  });

  test('on this machine detection answers cleanly (a browser when one is installed)', (t) => {
    const result = resolveBrowser({});
    // Not asserted strictly — a machine without any browser must still get a clean answer.
    assert.ok(result.source === 'detected' || result.source === 'none');
    if (result.source === 'detected') assert.ok(result.path && result.path.length > 0);
    else t.skip('No browser installed here; detection answered none (correct).');
  });
});
