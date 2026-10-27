// Build every entry OpenChamber loads (docs/SPEC.md §12). OpenChamber never compiles
// TypeScript, so `dist/` must exist before a folder install: run `npm run build`.
//
//   dist/panel/      index.html, styles.css, main.js  — panel + page guest (IIFE, browser)
//   dist/background/ index.html, main.js              — slash-command resolver (IIFE, browser)
//   dist/service/    main.js                          — local service (ESM, Node)
//
// The design-frame bridge is bundled first, in memory, and injected into the panel bundle
// as the string constant `__DC_BRIDGE__` (src/guest/globals.d.ts).
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...parts) => path.join(root, ...parts);
const dist = at('dist');

const browser = { bundle: true, format: 'iife', platform: 'browser', target: ['es2020'], sourcemap: false, logLevel: 'warning', legalComments: 'none' };

await rm(dist, { recursive: true, force: true });
await mkdir(at('dist', 'panel'), { recursive: true });
await mkdir(at('dist', 'background'), { recursive: true });

// (1) Bridge → in-memory IIFE string.
const bridgeResult = await build({ ...browser, entryPoints: [at('src', 'guest', 'bridge', 'bridge.ts')], write: false, minify: true });
const bridgeFile = bridgeResult.outputFiles[0];
if (!bridgeFile) throw new Error('build: the bridge bundle produced no output.');
const bridge = bridgeFile.text;
// The bridge is injected inside a <script> element of the design document.
if (/<\/script/i.test(bridge)) throw new Error('build: the bridge bundle contains "</script", which would end its <script> element early.');
// A near-empty bridge means a placeholder entry was bundled: artboards would load with no
// hit-testing, pins, scroll sync or link handling.
if (Buffer.byteLength(bridge) < 1024) throw new Error(`build: the bridge bundle is only ${Buffer.byteLength(bridge)} bytes — is src/guest/bridge/bridge.ts the real bridge?`);

// (2) Panel + page guest.
await build({ ...browser, entryPoints: [at('src', 'ui', 'main.ts')], outfile: at('dist', 'panel', 'main.js'), define: { __DC_BRIDGE__: JSON.stringify(bridge) } });
if ((await readFile(at('dist', 'panel', 'main.js'), 'utf8')).includes('__DC_BRIDGE__')) {
  throw new Error('build: __DC_BRIDGE__ was not replaced in the panel bundle.');
}

// (3) Background guest.
await build({ ...browser, entryPoints: [at('src', 'guest', 'background-main.ts')], outfile: at('dist', 'background', 'main.js') });

// (4) Local service.
await build({
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node20'],
  sourcemap: false,
  logLevel: 'warning',
  entryPoints: [at('src', 'service', 'main.ts')],
  outfile: at('dist', 'service', 'main.js'),
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});

// (5) Static files.
await copyFile(at('src', 'ui', 'index.html'), at('dist', 'panel', 'index.html'));
await copyFile(at('src', 'ui', 'styles.css'), at('dist', 'panel', 'styles.css'));
await writeFile(
  at('dist', 'background', 'index.html'),
  '<!doctype html>\n<html lang="en">\n  <head><meta charset="utf-8" /><title>Design Chamber background</title></head>\n  <body><script src="main.js"></script></body>\n</html>\n',
);

const outputs = ['panel/index.html', 'panel/styles.css', 'panel/main.js', 'background/index.html', 'background/main.js', 'service/main.js'];
const sizes = await Promise.all(outputs.map(async (file) => `${file} ${((await stat(at('dist', file))).size / 1024).toFixed(1)} kB`));
console.log(`built dist/ (bridge ${(Buffer.byteLength(bridge) / 1024).toFixed(1)} kB)\n  ${sizes.join('\n  ')}`);
