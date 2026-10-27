import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { rulesPathOf } from '../../src/shared/agent/context.ts';
import { BRIEF_MAX, CHIP_TEXT_HARD_MAX, REVISION_TEXT_MAX } from '../../src/shared/limits.ts';
import type { DesignChip } from '../../src/shared/types.ts';
import { unavailable, type DesignStore } from '../../src/service/context.ts';
import { createRouter } from '../../src/service/http.ts';
import { registerChatRoutes, writeRulesFile } from '../../src/service/routes/chat.ts';
import { createFakeContext } from '../helpers/fake-context.ts';
import { useTmpRoot, type TmpRoot } from '../helpers/tmp-root.ts';
import { assertError, comment, createChatContext, REPO_RULES, seedDesign, serveRoutes, TOKEN } from './helpers.ts';

const rulesOf = (tmp: TmpRoot, slug: string): Promise<string> => readFile(tmp.at(`${slug}/.chamber/RULES.md`), 'utf8');

/** A project folder the discovery can read: a DESIGN.md and a Tailwind config with screens. */
const makeProject = async (tmp: TmpRoot): Promise<string> => {
  const dir = path.join(path.dirname(tmp.root), `${path.basename(tmp.root)}-project`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'DESIGN.md'), '# Brand\nteal');
  await writeFile(path.join(dir, 'tailwind.config.ts'), "export default { theme: { screens: { sm: '640px', lg: '1024px' } } }");
  return dir;
};

describe('POST /chip', () => {
  test('creates a pending design, writes RULES.md, and answers the chip', async (t) => {
    const tmp = await useTmpRoot(t);
    const projectDir = await makeProject(tmp);
    const ctx = createChatContext(tmp);
    const { call } = await serveRoutes(t, ctx);

    const reply = await call('/chip', {
      body: { kind: 'canvas', brief: 'A pricing page for a coffee subscription. Three plans.', preset: 'minimal-saas', projectDirectory: projectDir, sessionId: 'ses_abc' },
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.json));
    const { slug, chip } = reply.json as { slug: string; chip: DesignChip };

    // What the store was asked to create: derived title, brief, preset, project; the chat id is NOT stored (§10.1).
    assert.equal(ctx.creates.length, 1);
    assert.deepEqual(ctx.creates[0], {
      kind: 'canvas',
      title: 'A pricing page for a coffee subscription',
      brief: 'A pricing page for a coffee subscription. Three plans.',
      preset: 'minimal-saas',
      projectDirectory: projectDir,
    });

    const folder = tmp.at(slug);
    assert.equal(chip.providerId, 'design-chamber');
    assert.equal(chip.id, `design:${slug}`);
    assert.deepEqual(chip.data, { slug, kind: 'canvas' });
    assert.equal(chip.url, pathToFileURL(folder).href);
    assert.equal(chip.title, 'A pricing page for a coffee subscription');
    assert.ok(chip.text.length <= CHIP_TEXT_HARD_MAX);
    assert.ok(chip.text.includes(`Write ONLY inside this folder: ${folder}`));
    assert.ok(chip.text.includes(`FIRST read, in full: ${rulesPathOf(folder)}`));
    assert.ok(chip.text.includes('DESIGN.md, tailwind.config.ts'), 'project sources are named');
    assert.ok(chip.text.includes('style preset (Minimal SaaS)'));
    // Screens at 640 and 1024 are both ≤ 1024 (tablet), and min-width screens imply a mobile-first phone.
    assert.ok(chip.text.includes('breakpoints (640, 1024) suggest Phone 390×844, Tablet 768×1024'), 'project breakpoints suggest viewports');

    // The file the chip makes mandatory reading exists, and holds the preset and both rules files.
    const rules = await rulesOf(tmp, slug);
    assert.ok(rules.includes(await readFile(path.join(REPO_RULES, 'DESIGN-RULES.md'), 'utf8')));
    assert.ok(rules.includes(await readFile(path.join(REPO_RULES, 'QUESTIONS.md'), 'utf8')));
    assert.ok(rules.includes(await readFile(path.join(REPO_RULES, 'presets', 'minimal-saas.md'), 'utf8')));
    assert.ok(rules.includes('- `DESIGN.md` — design document'));
    assert.ok(rules.includes(`Folder — write ONLY inside it: ${folder}`));
    assert.deepEqual((await readdir(tmp.at(`${slug}/.chamber`))).sort(), ['RULES.md', 'state.json'], 'no temp file is left behind');
  });

  test('an artifact without a preset or project', async (t) => {
    const tmp = await useTmpRoot(t);
    const ctx = createChatContext(tmp);
    const { call } = await serveRoutes(t, ctx);
    const reply = await call('/chip', { body: { kind: 'artifact', brief: '' } });
    assert.equal(reply.status, 200, JSON.stringify(reply.json));
    const { slug, chip } = reply.json as { slug: string; chip: DesignChip };
    assert.equal(chip.title, 'New artifact');
    assert.deepEqual(chip.data, { slug, kind: 'artifact' });
    assert.ok(chip.text.includes('New artifact:'));
    assert.ok(chip.text.includes('Brief: none — ask the user what to design.'));
    assert.ok(chip.text.includes('No project folder is open in this chat'));
    assert.ok((await rulesOf(tmp, slug)).includes('### Layer 3 — style preset: none chosen'));
    assert.deepEqual(ctx.creates[0]?.projectDirectory, null);
  });

  test('a chat running inside the Designs folder gets no project, not the design folder scanned as one', async (t) => {
    const tmp = await useTmpRoot(t);
    await tmp.write('other-design/DESIGN.md', '# not a project');
    const { call } = await serveRoutes(t, createChatContext(tmp));
    const reply = await call('/chip', { body: { kind: 'canvas', brief: 'x', projectDirectory: tmp.at('other-design') } });
    assert.equal(reply.status, 200);
    assert.ok(((reply.json.chip as DesignChip).text).includes('working in the Designs folder, not in a project'));
  });

  test('the largest accepted brief (2 000 chars) keeps the chip under the cap', async (t) => {
    const tmp = await useTmpRoot(t);
    const { call } = await serveRoutes(t, createChatContext(tmp));
    const reply = await call('/chip', { body: { kind: 'canvas', brief: 'b'.repeat(BRIEF_MAX) } });
    assert.equal(reply.status, 200);
    assert.ok((reply.json.chip as DesignChip).text.length <= CHIP_TEXT_HARD_MAX);
  });

  test('rejects bad input before creating anything', async (t) => {
    const tmp = await useTmpRoot(t);
    const ctx = createChatContext(tmp);
    const { call } = await serveRoutes(t, ctx);
    const long = await call('/chip', { body: { kind: 'canvas', brief: 'b'.repeat(BRIEF_MAX + 1) } });
    assertError(long, 422, 'invalid');
    assert.match(long.json.message as string, /2001 characters.*keeps 2000/);
    assertError(await call('/chip', { body: { kind: 'poster', brief: 'x' } }), 400, 'bad-request');
    assertError(await call('/chip', { body: { brief: 'x' } }), 400, 'bad-request');
    assertError(await call('/chip', { body: [] }), 400, 'bad-request');
    assertError(await call('/chip', { body: { kind: 'canvas', brief: 5 } }), 400, 'bad-request');
    assertError(await call('/chip', { body: { kind: 'canvas', preset: '../DESIGN-RULES' } }), 400, 'bad-request');
    assertError(await call('/chip', { body: { kind: 'canvas', preset: 'not-a-preset' } }), 400, 'bad-request');
    assertError(await call('/chip', { body: { kind: 'canvas', projectDirectory: '..\\..\\Windows' } }), 400, 'bad-path');
    assertError(await call('/chip', { body: { kind: 'canvas', projectDirectory: 'relative/dir' } }), 400, 'bad-path');
    assertError(await call('/chip', { body: { kind: 'canvas', projectDirectory: `${tmp.root}\0x` } }), 400, 'bad-path');
    assertError(await call('/chip', { body: { kind: 'canvas', sessionId: 'x'.repeat(200) } }), 400, 'bad-request');
    assert.equal(ctx.creates.length, 0, 'no design was created by any of them');
  });

  test('an unreadable project folder still makes a chip that says so', async (t) => {
    const tmp = await useTmpRoot(t);
    const { call } = await serveRoutes(t, createChatContext(tmp));
    const gone = `${tmp.root}-does-not-exist`;
    const reply = await call('/chip', { body: { kind: 'canvas', brief: 'x', projectDirectory: gone } });
    assert.equal(reply.status, 200);
    assert.ok((reply.json.chip as DesignChip).text.includes('could not be read (the folder does not exist)'));
  });

  test('says what is wrong when the bundled rules are missing, instead of sending a chip that points at nothing', async (t) => {
    const tmp = await useTmpRoot(t);
    const bare = await useTmpRoot(t);
    const { call } = await serveRoutes(t, createChatContext(tmp, { packageRoot: bare.root }));
    const reply = await call('/chip', { body: { kind: 'canvas', brief: 'x' } });
    assertError(reply, 500, 'internal');
    assert.match(reply.json.message as string, /Reinstall the extension/);
  });
});

describe('POST /designs/:slug/prompt', () => {
  test('revision: every open comment, numbered, with its element; RULES.md refreshed; chip for startSession', async (t) => {
    const tmp = await useTmpRoot(t);
    await seedDesign(tmp, 'checkout-redesign', {
      screens: [{ id: 'home', title: 'Home' }, { id: 'pay', title: 'Payment' }],
      comments: [
        comment('c_aaaa1'),
        comment('c_aaaa2', { screen: 'pay', viewport: 'phone', body: 'Bigger button', status: 'sent' }),
        comment('c_aaaa3', { screen: 'pay', body: 'Fix the total' }),
      ],
    });
    const { call } = await serveRoutes(t, createChatContext(tmp));

    const reply = await call('/designs/checkout-redesign/prompt', { body: { purpose: 'revision' } });
    assert.equal(reply.status, 200, JSON.stringify(reply.json));
    const folder = tmp.at('checkout-redesign');
    assert.deepEqual(reply.json.commentIds, ['c_aaaa1', 'c_aaaa3'], 'open comments only, in order');
    assert.deepEqual(reply.json.omitted, []);
    const text = reply.json.text as string;
    assert.ok(text.startsWith(`[Design Chamber] Revise "Checkout redesign" — 2 comments. Folder: ${folder}. Rules: ${rulesPathOf(folder)}`));
    assert.ok(text.includes('1. Screen "Home" (screens/home.html) @ Laptop 1280×800'));
    assert.ok(text.includes('2. Screen "Payment" (screens/pay.html) @ Laptop 1280×800'));
    assert.ok(text.includes('element: `main > section.hero > h1`'));
    assert.ok(text.includes('→ Fix the total') && !text.includes('Bigger button'));
    const chip = reply.json.chip as DesignChip;
    assert.equal(chip.id, 'design:checkout-redesign');
    assert.ok(chip.text.startsWith('[Design Chamber] Continue canvas: "Checkout redesign"'));
    assert.ok((await rulesOf(tmp, 'checkout-redesign')).includes('Folder — write ONLY inside it:'), 'RULES.md was (re)written');
  });

  test('named comment ids select exactly those, whatever their status', async (t) => {
    const tmp = await useTmpRoot(t);
    await seedDesign(tmp, 'd', { comments: [comment('c_aaaa1'), comment('c_aaaa2', { status: 'resolved', body: 'Resolved one' }), comment('c_aaaa3')] });
    const { call } = await serveRoutes(t, createChatContext(tmp));
    const reply = await call('/designs/d/prompt', { body: { purpose: 'revision', commentIds: ['c_aaaa2', 'c_zzzz9'] } });
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.json.commentIds, ['c_aaaa2'], 'an id that no longer exists is skipped');
    assert.ok((reply.json.text as string).includes('→ Resolved one'));
  });

  test('anchorStates from the page flag moved and missing elements; malformed states → 400', async (t) => {
    const tmp = await useTmpRoot(t);
    await seedDesign(tmp, 'd', { comments: [comment('c_aaaa1'), comment('c_aaaa2'), comment('c_aaaa3')] });
    const { call } = await serveRoutes(t, createChatContext(tmp));
    const reply = await call('/designs/d/prompt', {
      body: { purpose: 'revision', anchorStates: { c_aaaa1: 'exact', c_aaaa2: 'moved', c_aaaa3: 'detached', c_gone99: 'moved' } },
    });
    assert.equal(reply.status, 200);
    const lines = (reply.json.text as string).split('\n').filter((line) => line.includes('element:'));
    assert.equal(lines.length, 3);
    assert.doesNotMatch(lines[0] ?? '', /\(moved|\(not found/);
    assert.match(lines[1] ?? '', /\(moved — matched by text\)$/);
    assert.match(lines[2] ?? '', /\(not found in current file\)$/);
    for (const anchorStates of [{ c_aaaa1: 'lost' }, { 'not an id': 'moved' }, ['moved'], 'moved']) {
      assertError(await call('/designs/d/prompt', { body: { purpose: 'revision', anchorStates } }), 400, 'bad-request');
    }
  });

  test('nothing to send → 422 with a sentence; malformed ids → 400', async (t) => {
    const tmp = await useTmpRoot(t);
    await seedDesign(tmp, 'd', { comments: [comment('c_aaaa1', { status: 'sent' })] });
    const { call } = await serveRoutes(t, createChatContext(tmp));
    const none = await call('/designs/d/prompt', { body: { purpose: 'revision' } });
    assertError(none, 422, 'invalid');
    assert.equal(none.json.message, 'There are no open comments to send.');
    assertError(await call('/designs/d/prompt', { body: { purpose: 'revision', commentIds: ['c_zzzz9'] } }), 422, 'invalid');
    assertError(await call('/designs/d/prompt', { body: { purpose: 'revision', commentIds: ['not an id'] } }), 400, 'bad-request');
    assertError(await call('/designs/d/prompt', { body: { purpose: 'revision', commentIds: 'c_aaaa1' } }), 400, 'bad-request');
    assertError(await call('/designs/d/prompt', { body: { purpose: 'shout' } }), 400, 'bad-request');
  });

  test('too many long comments: one message under the host cap, the rest reported as omitted', async (t) => {
    const tmp = await useTmpRoot(t);
    const many = Array.from({ length: 12 }, (_, i) => comment(`c_many${i}`, { body: `${i}: ${'w'.repeat(1900)}` }));
    await seedDesign(tmp, 'd', { comments: many });
    const { call } = await serveRoutes(t, createChatContext(tmp));
    const reply = await call('/designs/d/prompt', { body: { purpose: 'revision' } });
    assert.equal(reply.status, 200);
    const sent = reply.json.commentIds as string[];
    const omitted = reply.json.omitted as string[];
    assert.ok((reply.json.text as string).length <= REVISION_TEXT_MAX);
    assert.ok(omitted.length > 0 && sent.length > 0);
    assert.deepEqual([...sent, ...omitted], many.map((c) => c.id));
    assert.ok((reply.json.text as string).includes(`of 12 (the rest will follow in a later message)`));
  });

  test('continue: a short resume message and the chip; no comments needed', async (t) => {
    const tmp = await useTmpRoot(t);
    await seedDesign(tmp, 'd', { comments: [comment('c_aaaa1')] });
    const { call } = await serveRoutes(t, createChatContext(tmp));
    const reply = await call('/designs/d/prompt', { body: { purpose: 'continue' } });
    assert.equal(reply.status, 200);
    assert.deepEqual([reply.json.commentIds, reply.json.omitted], [[], []]);
    assert.ok((reply.json.text as string).includes('Resuming the canvas "Checkout redesign"'));
    assert.ok((reply.json.text as string).includes('1 pinned comment is waiting'));
    assert.equal((reply.json.chip as DesignChip).data.slug, 'd');
  });

  test('an artifact revision names index.html', async (t) => {
    const tmp = await useTmpRoot(t);
    await seedDesign(tmp, 'page', { kind: 'artifact', comments: [comment('c_aaaa1', { screen: null })] });
    const { call } = await serveRoutes(t, createChatContext(tmp));
    const reply = await call('/designs/page/prompt', { body: { purpose: 'revision' } });
    assert.ok((reply.json.text as string).includes('1. Artifact index.html @ Laptop 1280×800'));
  });

  test('refreshing RULES.md picks up a design system the agent has since confirmed', async (t) => {
    const tmp = await useTmpRoot(t);
    await seedDesign(tmp, 'd', { comments: [comment('c_aaaa1')] });
    const { call } = await serveRoutes(t, createChatContext(tmp));
    await call('/designs/d/prompt', { body: { purpose: 'continue' } });
    assert.match(await rulesOf(tmp, 'd'), /Status: not written yet/);
    await tmp.write('d/DESIGN.md', '# Design');
    await tmp.write('d/tokens.css', ':root{}');
    await call('/designs/d/prompt', { body: { purpose: 'continue' } });
    assert.match(await rulesOf(tmp, 'd'), /Status: not confirmed yet \(DESIGN\.md exists, tokens\.css exists\)/);
  });

  test('a RULES.md that cannot be refreshed does not block the message', async (t) => {
    const tmp = await useTmpRoot(t);
    await seedDesign(tmp, 'd', { comments: [comment('c_aaaa1')] });
    await tmp.write('d/.chamber/RULES.md/keep', 'RULES.md is a folder here, so the rename fails');
    const ctx = createChatContext(tmp);
    const { call } = await serveRoutes(t, ctx);
    const reply = await call('/designs/d/prompt', { body: { purpose: 'revision' } });
    assert.equal(reply.status, 200, JSON.stringify(reply.json));
    assert.ok(ctx.logs.some((line) => line.event === 'agent.rules-refresh-failed'));
  });

  test('unknown design → 404; bad slugs → 400', async (t) => {
    const tmp = await useTmpRoot(t);
    const { call } = await serveRoutes(t, createChatContext(tmp));
    assertError(await call('/designs/nope/prompt', { body: { purpose: 'continue' } }), 404, 'not-found');
    assertError(await call('/designs/Not_A_Slug/prompt', { body: { purpose: 'continue' } }), 400, 'bad-slug');
  });
});

describe('POST /artifacts/from-message', () => {
  const PAGE = '<!doctype html><html lang="en"><head><title>Tom &amp; Jerry</title></head><body><h1>Hi</h1></body></html>';

  test('creates an artifact from the longest HTML block, linked to the message session, and writes RULES.md via the hook', async (t) => {
    const tmp = await useTmpRoot(t);
    const projectDir = await makeProject(tmp);
    const ctx = createChatContext(tmp);
    const { call } = await serveRoutes(t, ctx);
    const uploadId = ctx.seedUpload(`Here is the page:\n\n\`\`\`html\n<p>small</p>\n\`\`\`\n\n\`\`\`html\n${PAGE}\n\`\`\`\n`);
    const reply = await call('/artifacts/from-message', { body: { uploadId, sessionId: 'ses_42', sessionTitle: 'My chat', messageId: 'msg_1', directory: projectDir } });
    assert.equal(reply.status, 200, JSON.stringify(reply.json));
    const slug = reply.json.slug as string;
    assert.deepEqual(ctx.creates[0], {
      kind: 'artifact',
      title: 'Tom & Jerry',
      brief: '',
      preset: null,
      projectDirectory: projectDir,
      sessionId: 'ses_42',
      html: PAGE,
    });
    assert.equal(await tmp.read(`${slug}/index.html`), PAGE);
    // The `onCreate` hook (registered by registerChatRoutes) wrote the instructions for this design.
    const rules = await rulesOf(tmp, slug);
    assert.ok(rules.includes('(artifact)'));
    assert.ok(rules.includes('- `DESIGN.md` — design document'));
  });

  test('falls back to the message heading, then the session title', async (t) => {
    const tmp = await useTmpRoot(t);
    const ctx = createChatContext(tmp);
    const { call } = await serveRoutes(t, ctx);
    const body = (id: string) => ({ uploadId: id, sessionId: 's', sessionTitle: 'Planning chat', messageId: 'm', directory: null });
    await call('/artifacts/from-message', { body: body(ctx.seedUpload('## A pricing page\n```html\n<div>x</div>\n```')) });
    await call('/artifacts/from-message', { body: body(ctx.seedUpload('```html\n<div>x</div>\n```')) });
    assert.deepEqual(ctx.creates.map((create) => create.title), ['A pricing page', 'Planning chat']);
  });

  test('no HTML block → 422 no-html and nothing is created', async (t) => {
    const tmp = await useTmpRoot(t);
    const ctx = createChatContext(tmp);
    const { call } = await serveRoutes(t, ctx);
    const reply = await call('/artifacts/from-message', { body: { uploadId: ctx.seedUpload('Just words and `code`.'), sessionId: 's', sessionTitle: 't', messageId: 'm', directory: null } });
    assertError(reply, 422, 'no-html');
    assert.equal(ctx.creates.length, 0);
  });

  test('open: true leaves one open request for the rail; DELETE /open-request takes it exactly once', async (t) => {
    const tmp = await useTmpRoot(t);
    const ctx = createChatContext(tmp);
    const { call } = await serveRoutes(t, ctx);
    const body = (id: string, open?: boolean) => ({ uploadId: id, sessionId: 's', sessionTitle: 'Chat', messageId: 'm', directory: null, ...(open === undefined ? {} : { open }) });
    await call('/artifacts/from-message', { body: body(ctx.seedUpload(`\`\`\`html\n${PAGE}\n\`\`\``)) });
    assert.deepEqual((await call('/open-request', { method: 'DELETE' })).json, { request: null }, 'no request without open');
    const reply = await call('/artifacts/from-message', { body: body(ctx.seedUpload(`\`\`\`html\n${PAGE}\n\`\`\``), true) });
    assert.equal(reply.json.title, 'Tom & Jerry');
    const taken = await call('/open-request', { method: 'DELETE' });
    assert.equal((taken.json.request as { slug: string }).slug, reply.json.slug);
    assert.deepEqual((await call('/open-request', { method: 'DELETE' })).json, { request: null }, 'taken once');
    assertError(await call('/artifacts/from-message', { body: body(ctx.seedUpload('```html\n<p>x</p>\n```'), 'yes' as unknown as boolean) }), 400, 'bad-request');
  });

  test('an unknown upload → 404; malformed bodies → 400', async (t) => {
    const tmp = await useTmpRoot(t);
    const ctx = createChatContext(tmp);
    const { call } = await serveRoutes(t, ctx);
    const ok = { uploadId: 'u_0123456789abcdef', sessionId: 's', sessionTitle: 't', messageId: 'm', directory: null };
    assertError(await call('/artifacts/from-message', { body: ok }), 404, 'not-found');
    assertError(await call('/artifacts/from-message', { body: { ...ok, uploadId: '../x' } }), 400, 'bad-request');
    assertError(await call('/artifacts/from-message', { body: { ...ok, sessionId: '' } }), 400, 'bad-request');
    assertError(await call('/artifacts/from-message', { body: { ...ok, messageId: 7 } }), 400, 'bad-request');
    assertError(await call('/artifacts/from-message', { body: { ...ok, sessionTitle: undefined } }), 400, 'bad-request');
    assertError(await call('/artifacts/from-message', { body: { ...ok, directory: 'relative' } }), 400, 'bad-path');
    assertError(await call('/artifacts/from-message', { body: 'text' }), 400, 'bad-request');
  });
});

describe('auth and traversal on every route', () => {
  const routes = [
    { route: '/chip', body: { kind: 'canvas', brief: 'x' } },
    { route: '/designs/some-design/prompt', body: { purpose: 'continue' } },
    { route: '/artifacts/from-message', body: { uploadId: 'u_0123456789abcdef', sessionId: 's', sessionTitle: 't', messageId: 'm', directory: null } },
  ];

  test('a missing or wrong bearer token is refused before anything runs', async (t) => {
    const tmp = await useTmpRoot(t);
    const ctx = createChatContext(tmp);
    const { call } = await serveRoutes(t, ctx);
    for (const { route, body } of routes) {
      assertError(await call(route, { body, token: null }), 401, 'unauthorized');
      assertError(await call(route, { body, token: 'wrong-token' }), 401, 'unauthorized');
      assertError(await call(route, { body, token: `${TOKEN}x` }), 401, 'unauthorized');
      assertError(await call(route, { body, token: TOKEN.slice(0, -1) }), 401, 'unauthorized');
    }
    assert.equal(ctx.creates.length, 0);
    assert.deepEqual(await readdir(tmp.root), [], 'nothing was written');
  });

  test('traversal in the slug never reaches the filesystem', async (t) => {
    const tmp = await useTmpRoot(t);
    await tmp.write('../outside-marker.txt', 'x').catch(() => undefined);
    const { call } = await serveRoutes(t, createChatContext(tmp));
    for (const slug of ['..%2F..%2Fetc', '..%5C..%5Cwindows', '%2e%2e%2f', 'a%2Fb', '..%00', 'C%3A%5Cx', '..', '.', 'UPPER', 'a b', 'x'.repeat(80)]) {
      const reply = await call(`/designs/${slug}/prompt`, { body: { purpose: 'continue' } });
      assert.ok([400, 404].includes(reply.status), `${slug} → ${reply.status}`);
      assert.notEqual(reply.status, 200);
    }
    assert.deepEqual(await readdir(tmp.root), [], 'nothing was created under the root');
  });
});

describe('RULES.md writer and the onCreate hook', () => {
  test('writeRulesFile writes atomically and skips an unchanged file', async (t) => {
    const tmp = await useTmpRoot(t);
    await tmp.write('d/design.json', '{}');
    await writeRulesFile(tmp.at('d'), 'one\n');
    const file = tmp.at('d/.chamber/RULES.md');
    assert.equal(await readFile(file, 'utf8'), 'one\n');
    const past = new Date(Date.now() - 60_000);
    await utimes(file, past, past);
    await writeRulesFile(tmp.at('d'), 'one\n');
    assert.equal((await stat(file)).mtimeMs, past.getTime(), 'unchanged bytes are not rewritten');
    await writeRulesFile(tmp.at('d'), 'two\n');
    assert.equal(await readFile(file, 'utf8'), 'two\n');
    assert.deepEqual(await readdir(tmp.at('d/.chamber')), ['RULES.md']);
  });

  test('refuses a .chamber that is a file or a link, rather than writing through it', async (t) => {
    const tmp = await useTmpRoot(t);
    await tmp.write('plain/.chamber', 'i am a file');
    await assert.rejects(writeRulesFile(tmp.at('plain'), 'x'), /not a normal folder/);

    const outside = await useTmpRoot(t, 'dc-outside-');
    await mkdir(tmp.at('linked'), { recursive: true });
    try {
      await symlink(outside.root, tmp.at('linked/.chamber'), 'junction');
    } catch (error) {
      t.diagnostic(`link not created (${(error as NodeJS.ErrnoException).code}); the link case is not exercised on this machine`);
      return;
    }
    await assert.rejects(writeRulesFile(tmp.at('linked'), 'x'), /not a normal folder/);
    assert.deepEqual(await readdir(outside.root), [], 'nothing was written outside the design folder');
  });

  test('registers one hook on the store and unregisters it on dispose', async (t) => {
    const tmp = await useTmpRoot(t);
    const ctx = createChatContext(tmp);
    await seedDesign(tmp, 'made-elsewhere');
    await serveRoutes(t, ctx);
    const record = await ctx.store.create({ kind: 'canvas', title: 'Hooked', brief: 'b' });
    assert.ok((await readFile(path.join(record.path, '.chamber', 'RULES.md'), 'utf8')).includes('instructions for "Hooked"'));
    await ctx.dispose();
    const after = await ctx.store.create({ kind: 'canvas', title: 'After dispose', brief: 'b' });
    await assert.rejects(readFile(path.join(after.path, '.chamber', 'RULES.md'), 'utf8'), { code: 'ENOENT' });
  });

  test('a store that is not wired yet does not stop the routes from registering', () => {
    const ctx = createFakeContext({ root: '.', overrides: { store: unavailable<DesignStore>('designs store') } });
    const router = createRouter({ token: TOKEN, log: ctx.log });
    assert.doesNotThrow(() => registerChatRoutes(router, ctx));
    assert.ok(ctx.logs.some((line) => line.level === 'warn' && line.event === 'agent.rules-hook-unavailable'));
    assert.deepEqual(router.registered().sort(), ['DELETE /open-request', 'POST /artifacts/from-message', 'POST /chip', 'POST /designs/:slug/prompt']);
  });
});
