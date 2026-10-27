// The real service process, started like the host starts it (GUEST_SERVICES.md).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { HealthResponse } from '../../../src/shared/api.ts';
import { useServiceProcess } from '../../helpers/service-process.ts';

const { version } = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string };

test('GET /health answers with the bearer and refuses without it', async (t) => {
  const service = await useServiceProcess(t);

  const ok = await service.request('/health');
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as HealthResponse;
  assert.equal(body.ok, true);
  assert.equal(body.version, version);
  assert.match(body.epoch, /^[0-9a-f-]{36}$/);

  for (const token of [null, 'wrong-token', '']) {
    const refused = await service.request('/health', { token });
    assert.equal(refused.status, 401, `token ${String(token)}`);
    assert.equal(((await refused.json()) as { error: string }).error, 'unauthorized');
  }
  assert.equal((await service.request('/no-such-route', { token: null })).status, 401);
  assert.equal((await service.request('/no-such-route')).status, 404);

  assert.doesNotMatch(service.output(), new RegExp(service.token), 'the token never reaches the log');
});

test('the epoch changes per process', async (t) => {
  const first = await useServiceProcess(t);
  const second = await useServiceProcess(t);
  const a = (await (await first.request('/health')).json()) as HealthResponse;
  const b = (await (await second.request('/health')).json()) as HealthResponse;
  assert.notEqual(a.epoch, b.epoch);
});

test('the service refuses to start without its port and token', async () => {
  const { spawnSync } = await import('node:child_process');
  const main = fileURLToPath(new URL('../../../src/service/main.ts', import.meta.url));
  const run = spawnSync(process.execPath, [main], {
    env: { ...process.env, OPENCHAMBER_SERVICE_PORT: '', OPENCHAMBER_SERVICE_TOKEN: '' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /service\.env-missing/);
});
