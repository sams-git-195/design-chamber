// The composed service (src/service/compose.ts) — the exact wiring main.ts serves: every route
// in the shared route table is registered, every lane module is real (no "not built yet"
// placeholder left), and the WP3 RULES.md hook runs on the real store.

import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { ROUTE_KEYS } from '../../../src/shared/api.ts';
import { composeService, type ComposedService } from '../../../src/service/compose.ts';
import type { Logger } from '../../../src/service/context.ts';
import { useTmpRoot } from '../../helpers/tmp-root.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

type LogLine = { level: string; event: string };

const useComposed = async (t: TestContext): Promise<{ service: ComposedService; root: string; logs: LogLine[] }> => {
  const tmp = await useTmpRoot(t);
  const root = tmp.at('designs');
  await mkdir(root, { recursive: true });
  const settingsPath = tmp.at('settings.json');
  await writeFile(settingsPath, `${JSON.stringify({ version: 1, root })}\n`, 'utf8');
  const logs: LogLine[] = [];
  const log: Logger = {
    info: (event) => void logs.push({ level: 'info', event }),
    warn: (event) => void logs.push({ level: 'warn', event }),
    error: (event) => void logs.push({ level: 'error', event }),
  };
  const service = await composeService({
    token: 'compose-test-token',
    log,
    packageRoot: REPO_ROOT,
    version: '0.0.0-test',
    env: { DC_SETTINGS_PATH: settingsPath },
    homeDir: tmp.at('home'),
  });
  t.after(() => service.dispose());
  return { service, root, logs };
};

test('every route in the shared route table is registered on the composed router', async (t) => {
  const { service } = await useComposed(t);
  const registered = service.router.registered();
  const missing = ROUTE_KEYS.filter((key) => !registered.includes(key));
  assert.deepEqual(missing, [], `routes not served: ${missing.join(', ')}`);
  assert.equal(registered.length, ROUTE_KEYS.length, 'nothing registered outside the route table');
});

test('every lane module is the real one, and the RULES.md hook runs on the real store', async (t) => {
  const { service, root, logs } = await useComposed(t);
  const { ctx } = service;
  assert.equal(ctx.settings.root(), root);
  assert.equal(ctx.hub.epoch, ctx.epoch);
  // Placeholders throw "not built yet"; the real modules answer.
  assert.deepEqual(await ctx.store.list(), []);
  assert.equal(ctx.outbox.get(), null);
  assert.match(ctx.uploads.create(10), /^u_/);
  assert.ok(['unavailable', 'pending', 'ready'].includes(ctx.thumbnails.peek('nothing-here').state));
  await assert.rejects(ctx.renders.render('nothing-here', {}), (error: unknown) => (error as { code?: string }).code === 'not-found');

  const record = await ctx.store.create({ kind: 'canvas', title: 'Hook check', brief: '', preset: null, projectDirectory: null });
  await access(path.join(record.path, '.chamber', 'RULES.md'));
  assert.ok(!logs.some((line) => line.event === 'agent.rules-hook-unavailable'), 'the hook registered on the real store');
});
