// Thumbnail capture runs the design's own scripts in headless Chrome with
// `--host-resolver-rules=MAP * ~NOTFOUND`; an IP-literal URL (here the loopback) must not
// bypass it (review 2026-10-27). Without the flag the same page reaches the server, so this
// guards the flag. Uses the exact flags of thumbnails.ts. Skips without Chrome or Edge.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { resolveBrowser } from '../../../src/service/chrome.ts';
import { testBrowserFlags } from '../../helpers/chrome-or-skip.ts';

test('verify — a design rendered for a thumbnail cannot reach the network by IP address', async (t) => {
  const browser = resolveBrowser({}).path;
  if (browser === null) {
    t.skip('no Chrome or Edge installed');
    return;
  }
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;

  const work = await mkdtemp(path.join(os.tmpdir(), 'dc-review-thumb-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const page = path.join(work, 'index.html');
  await writeFile(
    page,
    `<!doctype html><html><body><h1>design</h1><img src="http://127.0.0.1:${port}/img-beacon"><script>fetch('http://127.0.0.1:${port}/fetch-beacon',{method:'POST',mode:'no-cors',body:'x'})</script></body></html>`,
  );
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--mute-audio',
    ...testBrowserFlags(),
    `--user-data-dir=${path.join(work, 'profile')}`,
    '--window-size=1280,800',
    '--force-device-scale-factor=0.25',
    '--virtual-time-budget=1500',
    `--screenshot=${path.join(work, 'thumb.png')}`,
    '--host-resolver-rules=MAP * ~NOTFOUND',
    pathToFileURL(page).href,
  ];
  await new Promise<void>((resolve) => {
    const child = spawn(browser, args, { stdio: 'ignore' });
    const timer = setTimeout(() => child.kill(), 20_000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.on('error', () => resolve());
  });
  assert.deepEqual(hits, [], `the design reached the network during thumbnail capture: ${hits.join(', ')}`);
});
