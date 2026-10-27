import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';

import { parsePreset } from '../../src/shared/agent/presets.ts';
import { PRESET_ID_PATTERN } from '../../src/shared/limits.ts';
import { listPresets, readPreset, readRulesDocs } from '../../src/service/routes/presets.ts';
import { createFakeContext } from '../helpers/fake-context.ts';
import { useTmpRoot } from '../helpers/tmp-root.ts';
import { assertError, REPO_RULES, serveRoutes, TOKEN } from './helpers.ts';

const REPO = path.resolve(REPO_RULES, '..');
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('parsePreset', () => {
  const GOOD = '# Minimal SaaS\n**id:** minimal-saas · **best for:** product landing pages, settings/app shells\n\nbody';

  test('reads name, id and best-for', () => {
    assert.deepEqual(parsePreset('minimal-saas', GOOD), { id: 'minimal-saas', name: 'Minimal SaaS', bestFor: 'product landing pages, settings/app shells' });
  });

  test('tolerates CRLF', () => {
    assert.equal(parsePreset('minimal-saas', GOOD.replace(/\n/g, '\r\n'))?.bestFor, 'product landing pages, settings/app shells');
  });

  test('refuses a file whose id differs from its name, or that lacks a name or an id line', () => {
    assert.equal(parsePreset('other-name', GOOD), null);
    assert.equal(parsePreset('minimal-saas', '**id:** minimal-saas · **best for:** x'), null);
    assert.equal(parsePreset('minimal-saas', '# Minimal SaaS\nno id line'), null);
    assert.equal(parsePreset('minimal-saas', '# Minimal SaaS\n**id:** minimal-saas'), null);
    assert.equal(parsePreset('Bad_Id', '# X\n**id:** Bad_Id · **best for:** y'), null);
  });
});

describe('bundled presets', () => {
  test('every file in rules/presets parses, and its id is its file name', async () => {
    const files = (await readdir(path.join(REPO_RULES, 'presets'))).filter((name) => name.endsWith('.md'));
    assert.ok(files.length >= 10);
    for (const name of files) {
      const stem = name.slice(0, -3);
      const parsed = parsePreset(stem, await readFile(path.join(REPO_RULES, 'presets', name), 'utf8'));
      assert.ok(parsed, `${name} parses`);
      assert.equal(parsed.id, stem);
      assert.ok(PRESET_ID_PATTERN.test(parsed.id));
      assert.ok(parsed.name.length > 0 && parsed.bestFor.length > 0);
    }
  });

  test('listPresets answers all of them, sorted by name', async () => {
    const presets = await listPresets(REPO, silent);
    assert.deepEqual(
      presets.map((preset) => preset.id).sort(),
      ['brutalist', 'data-dense-dashboard', 'editorial', 'luxury', 'minimal-saas', 'nocturne', 'playful', 'poster-print', 'technical-mono', 'warm-craft'],
    );
    assert.deepEqual(presets.map((preset) => preset.name), [...presets.map((preset) => preset.name)].sort((a, b) => a.localeCompare(b, 'en')));
    const minimal = presets.find((preset) => preset.id === 'minimal-saas');
    assert.deepEqual(minimal, { id: 'minimal-saas', name: 'Minimal SaaS', bestFor: 'product landing pages, settings/app shells, developer tools with a crisp brand' });
    const poster = presets.find((preset) => preset.id === 'poster-print');
    assert.equal(poster?.name, 'Poster / Print');
  });

  test('readPreset answers the verbatim file; ids that are not bundled presets answer null', async () => {
    const found = await readPreset(REPO, 'editorial');
    assert.equal(found?.text, await readFile(path.join(REPO_RULES, 'presets', 'editorial.md'), 'utf8'));
    for (const id of ['nope', '../DESIGN-RULES', '..\\x', 'minimal-saas.md', '', 'a/b', 'MINIMAL']) assert.equal(await readPreset(REPO, id), null, id);
  });

  test('readRulesDocs returns both rules files verbatim', async () => {
    const docs = await readRulesDocs(REPO);
    assert.equal(docs.designRules, await readFile(path.join(REPO_RULES, 'DESIGN-RULES.md'), 'utf8'));
    assert.equal(docs.questions, await readFile(path.join(REPO_RULES, 'QUESTIONS.md'), 'utf8'));
  });

  test('readRulesDocs says what is missing, in a sentence the user can act on', async (t) => {
    const empty = await useTmpRoot(t);
    await assert.rejects(readRulesDocs(empty.root), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'internal');
      assert.match((error as Error).message, /rules\/DESIGN-RULES\.md/);
      assert.match((error as Error).message, /Reinstall/);
      return true;
    });
  });

  test('a preset file that does not parse is skipped and logged; a missing folder lists nothing', async (t) => {
    const pkg = await useTmpRoot(t);
    await pkg.write('rules/presets/good.md', '# Good\n**id:** good · **best for:** things');
    await pkg.write('rules/presets/broken.md', 'no header');
    await pkg.write('rules/presets/renamed.md', '# Renamed\n**id:** other · **best for:** x');
    await pkg.write('rules/presets/notes.txt', 'ignored');
    const warnings: string[] = [];
    const presets = await listPresets(pkg.root, { ...silent, warn: (event, fields) => void warnings.push(`${event}:${String(fields?.file ?? '')}`) });
    assert.deepEqual(presets.map((preset) => preset.id), ['good']);
    assert.deepEqual(warnings.sort(), ['presets.file-skipped:broken.md', 'presets.file-skipped:renamed.md']);

    const none = await useTmpRoot(t);
    assert.deepEqual(await listPresets(none.root, silent), []);
  });

  test('rules files checked out or unzipped with CRLF read as LF, so RULES.md is the same bytes everywhere', async (t) => {
    const pkg = await useTmpRoot(t);
    await pkg.write('rules/DESIGN-RULES.md', '# Rules\r\n\r\nOne.\r\nTwo.\r\n');
    await pkg.write('rules/QUESTIONS.md', '# Questions\rold mac line\n');
    await pkg.write('rules/presets/crlf.md', '# Crlf\r\n**id:** crlf · **best for:** windows checkouts\r\n\r\nbody\r\n');
    const docs = await readRulesDocs(pkg.root);
    assert.equal(docs.designRules, '# Rules\n\nOne.\nTwo.\n');
    assert.equal(docs.questions, '# Questions\nold mac line\n');
    const preset = await readPreset(pkg.root, 'crlf');
    assert.equal(preset?.text, '# Crlf\n**id:** crlf · **best for:** windows checkouts\n\nbody\n');
  });
});

describe('GET /presets', () => {
  test('answers the bundled presets with the bearer token', async (t) => {
    const tmp = await useTmpRoot(t);
    const { call } = await serveRoutes(t, createFakeContext({ root: tmp.root }));
    const reply = await call('/presets');
    assert.equal(reply.status, 200);
    const presets = reply.json.presets as { id: string; name: string; bestFor: string }[];
    assert.equal(presets.length, 10);
    assert.ok(presets.every((preset) => preset.id && preset.name && preset.bestFor));
  });

  test('refuses a missing or wrong token', async (t) => {
    const tmp = await useTmpRoot(t);
    const { call } = await serveRoutes(t, createFakeContext({ root: tmp.root }));
    assertError(await call('/presets', { token: null }), 401, 'unauthorized');
    assertError(await call('/presets', { token: `${TOKEN}x` }), 401, 'unauthorized');
  });
});
