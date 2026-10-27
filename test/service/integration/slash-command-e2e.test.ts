// `/design` and `/artifact` end to end (docs/SPEC.md §10.1): the background frame's flow —
// `createFlows(...).resolveSlashCommand` on the real guest service client — against the BUILT
// service over HTTP with the bearer, the way the host proxies `serviceRequest`. The chip comes
// back as the host's attach request, the pending design exists on disk with its brief, and
// `.chamber/RULES.md` is written next to it.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import type { GuestRequest, GuestRequestResult } from '@openchamber/sdk';

import { createFakeHost } from '../../../src/guest/fake-services.ts';
import { CHIP_ID_PREFIX, createFlows } from '../../../src/guest/flows.ts';
import { createGuestHost } from '../../../src/guest/host.ts';
import { createServiceClient, type ServiceTransport } from '../../../src/guest/service-client.ts';
import { CHIP_PROVIDER_ID, type DesignJson } from '../../../src/shared/types.ts';
import { BUILT_MAIN, useServiceProcess, type RunningService } from '../../helpers/service-process.ts';
import { useTmpRoot } from '../../helpers/tmp-root.ts';

/** The host's `serviceRequest`, as a loopback HTTP call with the bearer. */
const httpTransport = (service: RunningService): ServiceTransport => ({
  serviceRequest: async (request: GuestRequest): Promise<GuestRequestResult> => {
    const answer = await service.request(request.path, {
      method: request.method,
      ...(request.query ? { query: request.query } : {}),
      // The client already JSON-encoded the body; the helper encodes again, so hand it the value.
      ...(request.body !== undefined ? { body: JSON.parse(request.body) as unknown } : {}),
    });
    return { status: answer.status, body: await answer.text() };
  },
});

test('/design and /artifact resolve to a chip through the real service client; the design and RULES.md are on disk', { timeout: 60_000 }, async (t) => {
  if (!existsSync(BUILT_MAIN)) {
    t.skip('dist/service/main.js is missing — run `npm run build` (npm run check does) to test the built service.');
    return;
  }
  const tmp = await useTmpRoot(t, 'dc-slash-');
  const root = tmp.at('designs');
  const project = tmp.at('project');
  await mkdir(root, { recursive: true });
  await mkdir(project, { recursive: true });
  const settingsPath = await tmp.write('settings.json', { version: 1, root, downloadsDir: tmp.at('downloads') });
  const service = await useServiceProcess(t, { DC_SETTINGS_PATH: settingsPath }, BUILT_MAIN);

  const fakeHost = createFakeHost({ surface: 'background', directory: project, session: { id: 'ses_chat', title: 'Pricing work', busy: false } });
  const host = createGuestHost(fakeHost);
  fakeHost.emitReady();
  const client = createServiceClient(httpTransport(service));
  const flows = createFlows({ host, client });

  for (const [command, args, kind, brief] of [
    ['design', '  A pricing page for a coffee club  ', 'canvas', 'A pricing page for a coffee club'],
    ['artifact', 'Invoice template', 'artifact', 'Invoice template'],
  ] as const) {
    const attach = await flows.resolveSlashCommand({ command, args });
    assert.equal(attach.providerId, CHIP_PROVIDER_ID, command);
    assert.ok(attach.id.startsWith(CHIP_ID_PREFIX), `${command}: chip id ${attach.id}`);
    const data = attach.data as { slug?: unknown; kind?: unknown };
    assert.equal(typeof data.slug, 'string', command);
    assert.equal(data.kind, kind, command);
    assert.ok(attach.text && attach.text.length > 0, `${command}: the chip carries the agent context`);
    const slug = String(data.slug);

    const folder = path.join(root, slug);
    const design = JSON.parse(await readFile(path.join(folder, 'design.json'), 'utf8')) as DesignJson;
    assert.equal(design.kind, kind, command);
    assert.equal(design.brief, brief, command);
    const rules = await readFile(path.join(folder, '.chamber', 'RULES.md'), 'utf8');
    assert.ok(rules.trim().length > 0, `${command}: RULES.md is written`);

    const { designs } = await client.call('GET /designs');
    assert.ok(designs.some((entry) => entry.slug === slug && entry.pending), `${command}: listed as waiting for the agent`);
  }

  await assert.rejects(flows.resolveSlashCommand({ command: 'nope', args: '' }), (error: Error) => error.message.length > 0);
});
