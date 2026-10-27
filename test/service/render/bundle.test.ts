import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import {
  bundleDocument,
  classifyRef,
  createLiveFileSource,
  escapeScriptBody,
  injectBridgePlaceholder,
  BundleTooLarge,
  type FileSource,
} from '../../../src/service/bundle.ts';
import { BRIDGE_PLACEHOLDER } from '../../../src/shared/bridge-protocol.ts';
import { useTmpRoot, type TmpRoot } from '../../helpers/tmp-root.ts';
import { RED_PNG_B64, redPng } from './harness.ts';

const bundle = async (tmp: TmpRoot, slug: string, entryRel: string, mode: 'render' | 'export' = 'render') => {
  const source = createLiveFileSource(tmp.at(slug));
  return bundleDocument(source, entryRel, { mode });
};

/** The standard fixture design; individual tests add or override files. */
const writeFixture = async (tmp: TmpRoot, slug = 'art'): Promise<string> =>
  tmp.writeDesign(slug, {
    'index.html': `<!doctype html>
<html>
<head>
  <title>Bundle <img src="ignored.png"> test</title>
  <link rel="stylesheet" href="assets/main.css">
  <link rel="stylesheet" media="print" href="assets/print.css">
  <link rel="icon" href="assets/pic.png">
  <style>.local{background:url('assets/pic.png')}</style>
  <script src="assets/app.js"></script>
</head>
<body>
  <h1>a &lt; b</h1>
  <img src="assets/pic.png" srcset="assets/pic.png 1x, assets/big.png 2x">
  <div style="background-image: url(assets/pic.png)">inline</div>
  <video poster="assets/pic.png"></video>
  <img src="assets/missing.png">
  <img src="../outside.png">
  <img src="https://cdn.example.com/x.png">
  <img src="/assets/pic.png">
  <object data="assets/plugin.swf"></object>
  <a href="screens/home.html">link stays as authored</a>
  <iframe src="partial.html"></iframe>
  <svg><use href="assets/pic.png"></use></svg>
  <textarea><img src="assets/pic.png"></textarea>
</body>
</html>`,
    'assets/main.css': `@import url("fonts.css");\n.hero{background:url(pic.png)}\n.remote{background:url(https://cdn.example.com/bg.png)}`,
    'assets/fonts.css': `@font-face{font-family:"X";src:url(fonts/x.woff2) format("woff2")}`,
    'assets/print.css': '@page{margin:1cm}',
    'assets/pic.png': redPng(),
    'assets/big.png': redPng(),
    'assets/fonts/x.woff2': Buffer.from('not really woff but bytes'),
    'assets/app.js': `console.log("hi"); const s = "</script><script>alert(1)</" + "script>";`,
    'partial.html': '<!doctype html><p>embedded <img src="assets/pic.png"></p>',
    'screens/home.html': '<!doctype html><img src="../assets/pic.png"><img src="../../secret.png">',
  });

describe('classifyRef (pure containment)', () => {
  const dir = process.platform === 'win32' ? 'C:\\Designs\\art' : '/Designs/art';
  test('local, root-relative, remote, scheme and escaping refs classify correctly', () => {
    assert.deepEqual(classifyRef('assets/pic.png', '', dir), { kind: 'local', rel: 'assets/pic.png' });
    assert.deepEqual(classifyRef('./assets/pic.png', 'screens', dir), { kind: 'local', rel: 'screens/assets/pic.png' });
    assert.deepEqual(classifyRef('../assets/pic.png', 'screens', dir), { kind: 'local', rel: 'assets/pic.png' });
    assert.deepEqual(classifyRef('/assets/pic.png', '', dir), { kind: 'local', rel: 'assets/pic.png' });
    assert.deepEqual(classifyRef('pic.png?v=2#frag', '', dir), { kind: 'local', rel: 'pic.png' });
    assert.deepEqual(classifyRef('my%20pic.png', '', dir), { kind: 'local', rel: 'my pic.png' });
    assert.equal(classifyRef('../../outside.png', '', dir).kind, 'blocked');
    assert.equal(classifyRef('../..', '', dir).kind, 'blocked');
    assert.equal(classifyRef('C:\\evil\\x.png', '', dir).kind, 'blocked');
    assert.equal(classifyRef('\\\\server\\share\\x.png', '', dir).kind, 'blocked');
    assert.equal(classifyRef('file:///C:/evil/x.png', '', dir).kind, 'blocked');
    const external = classifyRef('https://cdn.example.com/x.png', '', dir);
    assert.equal(external.kind, 'external');
    assert.equal(classifyRef('//cdn.example.com/x.png', '', dir).kind, 'external');
    assert.equal(classifyRef('data:image/png;base64,AA', '', dir).kind, 'skip');
    assert.equal(classifyRef('#section', '', dir).kind, 'skip');
    assert.equal(classifyRef('mailto:a@b.c', '', dir).kind, 'skip');
  });

  test('backslash traversal is treated as a separator and blocked on every platform', () => {
    assert.equal(classifyRef('..\\..\\secret.png', '', dir).kind, 'blocked');
  });
});

describe('bundleDocument', () => {
  test('inlines stylesheets through the @import chain with url() fonts and images', async (t) => {
    const tmp = await useTmpRoot(t);
    await writeFixture(tmp);
    const result = await bundle(tmp, 'art', 'index.html');

    assert.ok(!result.html.includes('assets/main.css'), 'the stylesheet link is gone');
    assert.ok(!result.html.includes('<link rel="stylesheet"'), 'both stylesheet links became <style>');
    assert.ok(result.html.includes('@font-face'), 'the @imported sheet is inlined');
    assert.ok(result.html.includes(`data:font/woff2;base64,${Buffer.from('not really woff but bytes').toString('base64')}`), 'the font became a data URL');
    assert.ok(result.html.includes(`data:image/png;base64,${RED_PNG_B64}`), 'the CSS image became a data URL');
    assert.ok(result.html.includes('<style media="print">'), 'the media attribute survives');
    assert.ok(result.html.includes('@page{margin:1cm}'), 'the second sheet is inlined too');
    assert.ok(result.external.includes('https://cdn.example.com/bg.png'), 'the remote CSS background is reported external');
    // The favicon became a data URL as well.
    assert.ok(result.html.includes('rel="icon"') && !result.html.includes('href="assets/pic.png"'), 'icon inlined');
  });

  test('inlines scripts, srcset, inline style url(), poster and SVG use; escapes </script>', async (t) => {
    const tmp = await useTmpRoot(t);
    await writeFixture(tmp);
    const result = await bundle(tmp, 'art', 'index.html');

    // script src inlined with the closing tag escaped
    assert.ok(!result.html.includes('<script src='), 'no external script tag remains');
    assert.ok(result.html.includes('console.log("hi")'), 'the script body is inlined');
    assert.ok(!/<\/script><script>alert/.test(result.html), 'the embedded </script> is escaped, not raw');
    assert.ok(result.html.includes('<\\/script>'), 'escaped as <\\/script');
    assert.equal(escapeScriptBody('</SCRIPT x'), '<\\/SCRIPT x');

    // srcset: both candidates are data URLs, descriptors kept. (Browsers split srcset on
    // whitespace, so the commas inside data: URLs are safe.)
    const srcset = /srcset="([^"]+)"/.exec(result.html)?.[1] ?? '';
    assert.equal(srcset.match(/data:image\/png;base64,/g)?.length, 2, 'both srcset candidates are data URLs');
    assert.match(srcset, new RegExp(`^data:image/png;base64,${RED_PNG_B64} 1x, data:image/png;base64,${RED_PNG_B64} 2x$`));

    // inline style attribute + <style> element + poster + svg use
    assert.ok(result.html.includes('style="background-image: url(data:image/png;base64,'), 'inline style url() inlined');
    assert.ok(result.html.includes('.local{background:url(data:image/png;base64,'), '<style> url() inlined');
    assert.ok(result.html.includes('poster="data:image/png;base64,'), 'poster inlined');
    assert.ok(result.html.includes('<use href="data:image/png;base64,'), 'svg use href inlined');

    // iframe src became a data:text/html document that itself has the image inlined
    const iframeSrc = /<iframe src="data:text\/html;charset=utf-8,([^"]+)"/.exec(result.html)?.[1];
    assert.ok(iframeSrc, 'iframe src is a data URL');
    const embedded = decodeURIComponent(iframeSrc ?? '');
    assert.ok(embedded.includes(`data:image/png;base64,${RED_PNG_B64}`), 'the embedded document was bundled recursively');
    assert.ok(!embedded.includes('assets/pic.png'), 'no relative refs remain in the embedded document');

    // <a href> and title/textarea content are untouched
    assert.ok(result.html.includes('href="screens/home.html"'), 'anchor hrefs stay as authored');
    assert.ok(result.html.includes('<textarea><img src="assets/pic.png"></textarea>'), 'textarea text is never rewritten');
    assert.ok(result.html.includes('<title>Bundle <img src="ignored.png"> test</title>'), 'title text is never rewritten');
    assert.ok(result.html.includes('a &lt; b'), 'stray text and entities pass through');
  });

  test('missing, escaping, remote and object refs are reported, never inlined', async (t) => {
    const tmp = await useTmpRoot(t);
    await writeFixture(tmp);
    const result = await bundle(tmp, 'art', 'index.html');

    assert.deepEqual(result.missing, ['assets/missing.png']);
    assert.ok(result.html.includes('src="assets/missing.png"'), 'a missing ref stays as authored (fails closed in the blob doc)');
    assert.ok(result.blocked.includes('../outside.png'), 'the escaping ref is blocked');
    assert.ok(result.blocked.includes('assets/plugin.swf'), '<object data> is blocked (CSP object-src none)');
    assert.ok(result.external.includes('https://cdn.example.com/x.png'), 'the remote image is reported external');
    assert.ok(result.html.includes('src="https://cdn.example.com/x.png"'), 'the remote ref stays as authored');
    assert.ok(!result.blocked.includes('/assets/pic.png'), 'a root-relative ref resolves against the design root');
  });

  test('render mode injects the bridge placeholder at the start of <head>; export mode never does', async (t) => {
    const tmp = await useTmpRoot(t);
    await writeFixture(tmp);
    const render = await bundle(tmp, 'art', 'index.html', 'render');
    const exported = await bundle(tmp, 'art', 'index.html', 'export');
    assert.ok(render.html.includes(`<head>${BRIDGE_PLACEHOLDER}`), 'placeholder is the first child of head');
    assert.ok(!exported.html.includes(BRIDGE_PLACEHOLDER), 'export has no placeholder');

    // No <head>: one is created after <html>; a bare fragment gets it prepended.
    assert.equal(injectBridgePlaceholder('<html><body>x</body></html>'), `<html><head>${BRIDGE_PLACEHOLDER}</head><body>x</body></html>`);
    assert.equal(injectBridgePlaceholder('<!DOCTYPE html><p>x</p>'), `<!DOCTYPE html><head>${BRIDGE_PLACEHOLDER}</head><p>x</p>`);
    assert.equal(injectBridgePlaceholder('<p>x</p>'), `${BRIDGE_PLACEHOLDER}<p>x</p>`);
  });

  test('screens resolve ../assets and refuse escapes above the design folder', async (t) => {
    const tmp = await useTmpRoot(t);
    await writeFixture(tmp);
    const result = await bundle(tmp, 'art', 'screens/home.html');
    assert.ok(result.html.includes(`src="data:image/png;base64,${RED_PNG_B64}"`), '../assets/pic.png is inlined');
    assert.ok(result.blocked.includes('../../secret.png'), 'the escape above the design folder is blocked');
    assert.ok(result.html.includes('src="../../secret.png"'), 'the blocked ref stays as authored');
  });

  test('inputs list every file read, with sizes and mtimes (the cache-key fingerprint)', async (t) => {
    const tmp = await useTmpRoot(t);
    await writeFixture(tmp);
    const result = await bundle(tmp, 'art', 'index.html');
    const rels = result.inputs.map((input) => input.rel);
    assert.ok(rels.includes('index.html'));
    assert.ok(rels.includes('assets/main.css'));
    assert.ok(rels.includes('assets/fonts.css'));
    assert.ok(rels.includes('assets/fonts/x.woff2'));
    assert.ok(rels.includes('assets/app.js'));
    assert.ok(rels.includes('partial.html'));
    for (const input of result.inputs) {
      assert.ok(input.size > 0, `${input.rel} has a size`);
      assert.ok(input.mtimeMs > 0, `${input.rel} has an mtime`);
    }
  });

  test('@import cycles and depth are guarded', async (t) => {
    const tmp = await useTmpRoot(t);
    await tmp.writeDesign('cyc', {
      'index.html': '<link rel="stylesheet" href="a.css">',
      'a.css': '@import "b.css"; .a{color:red}',
      'b.css': '@import "a.css"; .b{color:blue}',
    });
    const result = await bundle(tmp, 'cyc', 'index.html');
    assert.ok(result.html.includes('.a{color:red}'), 'the cycle still inlines both sheets once');
    assert.ok(result.html.includes('.b{color:blue}'));
    assert.ok(result.warnings.some((warning) => warning.code === 'css-cycle'), 'the cycle is reported');

    await tmp.writeDesign('deep', {
      'index.html': '<link rel="stylesheet" href="d0.css">',
      ...Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => [`d${i}.css`, i < 11 ? `@import "d${i + 1}.css";` : '.end{color:red}']),
      ) as Record<string, string>,
    });
    const deep = await bundle(tmp, 'deep', 'index.html');
    assert.ok(deep.warnings.some((warning) => warning.code === 'css-depth'), 'the depth cap is reported');
  });

  test('module scripts with relative imports are inlined but warned about', async (t) => {
    const tmp = await useTmpRoot(t);
    await tmp.writeDesign('mod', {
      'index.html': '<script type="module" src="m.js"></script><script>import "./x.js";</script>',
      'm.js': 'import { a } from "./lib.js"; console.log(a);',
      'lib.js': 'export const a = 1;',
    });
    const result = await bundle(tmp, 'mod', 'index.html');
    assert.ok(result.html.includes('console.log(a)'), 'the module body is inlined');
    assert.ok(result.warnings.some((warning) => warning.code === 'module-import'), 'relative module imports are warned about');
  });

  test('tolerates malformed markup: unterminated tags, stray <, weird quoting', async (t) => {
    const tmp = await useTmpRoot(t);
    await tmp.writeDesign('messy', {
      'index.html': '<div><img src="pic.png"\n<p>5 < 6</p><img src=\'pic.png\'><span class=x >ok</span>',
      'pic.png': redPng(),
    });
    const result = await bundle(tmp, 'messy', 'index.html');
    assert.equal(result.html.match(new RegExp(`data:image/png;base64,${RED_PNG_B64}`, 'g'))?.length, 2, 'both images inlined');
    assert.ok(result.html.includes('5 < 6'), 'stray < passes through');
  });

  test('a symlinked asset that escapes the design folder is blocked (realpath containment)', async (t) => {
    const tmp = await useTmpRoot(t);
    await tmp.writeDesign('esc', { 'index.html': '<img src="link/secret.png">' });
    const outside = tmp.at('outside');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'secret.png'), redPng());
    try {
      await symlink(outside, tmp.at(path.join('esc', 'link')), 'junction');
    } catch {
      t.skip('This machine refuses symlink/junction creation without privileges.');
      return;
    }
    const result = await bundle(tmp, 'esc', 'index.html');
    assert.ok(result.blocked.includes('link/secret.png'), 'the junction escape is blocked');
    assert.ok(!result.html.includes(RED_PNG_B64), 'the outside bytes never reach the bundle');
  });

  test('a document over the 60 MB cap is refused', async (t) => {
    const tmp = await useTmpRoot(t);
    const big = `<!doctype html><p>${'x'.repeat(61 * 1024 * 1024)}</p>`;
    await tmp.writeDesign('big', { 'index.html': big });
    const source: FileSource = createLiveFileSource(tmp.at('big'));
    await assert.rejects(bundleDocument(source, 'index.html', { mode: 'render' }), BundleTooLarge);
  });
});
