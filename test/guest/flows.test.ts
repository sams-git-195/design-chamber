// Chat flows (docs/SPEC.md §10) against the fake host + fake service.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HostRequestError, type GuestMessageItem, type GuestSessionRecord, type PromptRequest, type StartSessionRequest } from '@openchamber/sdk';

import { createFakeServices, createFakeService, type FakeServices } from '../../src/guest/fake-services.ts';
import { createFlows, FlowError, MESSAGES, planReconciliation, sameDirectory, type Flows } from '../../src/guest/flows.ts';
import { createGuestHost } from '../../src/guest/host.ts';
import { createServiceClient } from '../../src/guest/service-client.ts';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const until = async (check: () => boolean, label: string): Promise<void> => {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${label}`);
};

type Setup = FakeServices & { flows: Flows };

const setup = (options: Parameters<typeof createFakeServices>[0] = {}, now?: () => number): Setup => {
  const fakes = createFakeServices(options);
  fakes.host.emitReady();
  return { ...fakes, flows: createFlows({ host: fakes.guestHost, client: fakes.client, ...(now ? { now } : {}) }) };
};

const COFFEE = 'coffee-subscription';
const LINKED = 'ses_fake_coffee';
const comments = (s: Setup) => s.service.designs.get(COFFEE)?.design.comments ?? [];
const routes = (s: Setup, from = 0) => s.service.requests.slice(from).map((request) => `${request.method} ${request.path}`);
const toasts = (s: Setup) => s.host.callsOf('toast').map(([request]) => (request as { message: string }).message);

// ---- §10.1 slash commands ----

test('/design and /artifact resolve to our chip via POST /chip with the frame directory + session', async () => {
  const s = setup({ surface: 'background', session: { id: 'ses_here', title: 'Here', busy: false } });
  const chip = await s.flows.resolveSlashCommand({ command: 'design', args: '  a pricing page  ' });
  assert.equal(chip.providerId, 'design-chamber');
  assert.match(chip.id, /^design:a-pricing-page$/);
  assert.deepEqual(chip.data, { slug: 'a-pricing-page', kind: 'canvas' });
  const body = JSON.parse(s.service.requests.at(-1)?.body ?? '{}');
  assert.deepEqual(body, { kind: 'canvas', brief: 'a pricing page', projectDirectory: 'C:\\Users\\you\\projects\\shop', sessionId: 'ses_here' });
  const artifact = await s.flows.resolveSlashCommand({ command: 'artifact', args: '' });
  assert.deepEqual(artifact.data, { slug: 'untitled-artifact', kind: 'artifact' });
  assert.equal(s.service.designs.get('a-pricing-page')?.design.sessionId, null, 'linking waits for reconciliation');
  await assert.rejects(s.flows.resolveSlashCommand({ command: 'deploy', args: '' }), FlowError);
});

test('slash command: a service error is rethrown as a plain Error with the service sentence', async () => {
  const fakes = createFakeServices();
  const client = createServiceClient({
    serviceRequest: async () => ({ status: 400, body: JSON.stringify({ error: 'bad-request', message: 'The brief is too long (over 2 000 characters).' }) }),
  });
  const flows = createFlows({ host: fakes.guestHost, client });
  await assert.rejects(flows.resolveSlashCommand({ command: 'design', args: 'x' }), (error: unknown) => {
    assert.ok(error instanceof Error && !(error instanceof FlowError));
    assert.equal(error.message, 'The brief is too long (over 2 000 characters).');
    return true;
  });
});

// ---- §10.2 new design ----

test('new design in a new chat: chip → startSession(open) → PATCH sessionId', async () => {
  const s = setup();
  const result = await s.flows.newDesign({ kind: 'canvas', brief: 'Checkout redesign', preset: 'minimal-saas', destination: 'new-chat' });
  const [request] = s.host.callsOf('startSession')[0] as [StartSessionRequest];
  assert.equal(request.text, 'Checkout redesign');
  assert.equal(request.navigation, 'open');
  assert.equal(request.id, `design:${result.slug}`);
  assert.equal(s.service.designs.get(result.slug)?.design.sessionId, result.sessionId);
  assert.equal(s.service.designs.get(result.slug)?.design.preset, 'minimal-saas');

  await s.flows.newDesign({ kind: 'artifact', brief: '   ', destination: 'new-chat' });
  assert.equal((s.host.callsOf('startSession')[1]?.[0] as StartSessionRequest).text, "Let's start this design.");
});

test('new design without a project: inline error, nothing created', async () => {
  const s = setup({ directory: null });
  const count = s.service.designs.size;
  await assert.rejects(s.flows.newDesign({ kind: 'canvas', brief: 'x', destination: 'new-chat' }), (error: unknown) => {
    assert.ok(error instanceof FlowError);
    assert.equal(error.code, 'no-project');
    assert.equal(error.message, MESSAGES.noProject);
    return true;
  });
  assert.equal(s.service.designs.size, count);
});

test('new design in the current chat: attach + compose(append); the page closes', async () => {
  const s = setup({ surface: 'page', session: { id: 'ses_cur', title: 'Current', busy: false } });
  const result = await s.flows.newDesign({ kind: 'canvas', brief: 'Landing page', destination: 'current-chat' });
  assert.equal(s.host.callsOf('attach').length, 1);
  assert.deepEqual(s.host.callsOf('compose')[0], [{ text: 'Landing page', mode: 'append' }]);
  assert.equal(s.host.callsOf('close').length, 1);
  assert.equal(result.sessionId, 'ses_cur');
  assert.equal(s.host.callsOf('startSession').length, 0);

  const rail = setup({ surface: 'panel', session: { id: 'ses_cur', title: 'Current', busy: false } });
  await rail.flows.newDesign({ kind: 'artifact', brief: '', destination: 'current-chat' });
  assert.equal(rail.host.callsOf('close').length, 0);
  assert.equal(rail.host.callsOf('compose').length, 0);
});

// ---- §10.3 continue in chat ----

test('continue in chat: opens the linked session', async () => {
  const s = setup();
  assert.deepEqual(await s.flows.continueInChat(COFFEE), { outcome: 'opened', sessionId: LINKED });
  assert.deepEqual(s.host.callsOf('openSession'), [[LINKED]]);
  assert.equal(s.host.callsOf('startSession').length, 0);
});

test('continue in chat: NO_SESSION falls back to a new session in the design project, then links it', async () => {
  const s = setup({ knownSessions: [] });
  s.host.projects = [
    { id: 'proj_shop', name: 'shop', directory: 'C:\\Users\\you\\projects\\shop' },
    { id: 'proj_brand', name: 'brand', directory: 'C:/Users/You/Projects/Brand/' },
  ];
  const coffee = s.service.designs.get(COFFEE);
  assert.ok(coffee);
  coffee.design.projectDirectory = 'C:\\Users\\you\\projects\\brand';
  const result = await s.flows.continueInChat(COFFEE);
  assert.equal(result.outcome, 'new-session');
  const [request] = s.host.callsOf('startSession')[0] as [StartSessionRequest];
  assert.equal(request.projectId, 'proj_brand');
  assert.equal(request.navigation, 'open');
  assert.match(request.text ?? '', /continue/i);
  assert.equal(coffee.design.sessionId, result.sessionId);
  assert.notEqual(result.sessionId, LINKED);

  // Other host errors are not swallowed.
  const t = setup();
  t.host.behavior.openSession = async () => {
    throw new HostRequestError('DISABLED', 'paused');
  };
  await assert.rejects(t.flows.continueInChat(COFFEE), /paused/);
});

test('continue in chat: no linked session starts one in the current project', async () => {
  const s = setup();
  const result = await s.flows.continueInChat('launch-announcement');
  assert.equal(result.outcome, 'new-session');
  assert.equal(s.host.callsOf('openSession').length, 0);
  assert.equal((s.host.callsOf('startSession')[0]?.[0] as StartSessionRequest).projectId, 'proj_shop');
});

// ---- §10.4 send comments ----

test('send comments, branch 1: the linked session is selected and idle → sent + marked with the latest version', async () => {
  const s = setup({ session: { id: LINKED, title: 'Coffee', busy: false } });
  const result = await s.flows.sendComments(COFFEE);
  assert.equal(result.outcome, 'sent');
  assert.deepEqual(result.commentIds, ['c_hero01']);
  const [prompt] = s.host.callsOf('prompt')[0] as [PromptRequest];
  assert.equal(prompt.send, true);
  assert.match(prompt.text, /Revise "Coffee subscription" — 1 comment/);
  const comment = comments(s)[0];
  assert.equal(comment?.status, 'sent');
  assert.equal(comment?.sentVersion, s.service.designs.get(COFFEE)?.versions.at(-1)?.n);
  assert.equal(toasts(s).length, 0);
});

/** Make the next `count` mark-sent calls fail like a service that restarted mid-send. */
const failMarkSent = (s: Setup, count: number): void => {
  const original = s.service.handle;
  let left = count;
  s.service.handle = async (request) => {
    if (request.path.endsWith('/comments/mark-sent') && left > 0) {
      left -= 1;
      return { status: 500, body: JSON.stringify({ error: 'internal', message: 'design.json is locked.' }) };
    }
    return original(request);
  };
};

test('send comments: a mark-sent failure after a delivered prompt is not a send error (KI-2)', async () => {
  const s = setup({ session: { id: LINKED, title: 'Coffee', busy: false } });
  failMarkSent(s, 2);
  const result = await s.flows.sendComments(COFFEE);
  assert.equal(result.outcome, 'sent', 'the chat got it: no rejection that would invite a resend');
  assert.equal(result.markFailed, true);
  assert.equal(comments(s)[0]?.status, 'open');
  assert.equal(s.host.callsOf('prompt').length, 1);

  // One failure is retried once and goes unnoticed.
  const t = setup({ session: { id: LINKED, title: 'Coffee', busy: false } });
  failMarkSent(t, 1);
  const retried = await t.flows.sendComments(COFFEE);
  assert.equal(retried.outcome, 'sent');
  assert.equal(retried.markFailed, undefined);
  assert.equal(comments(t)[0]?.status, 'sent');
});

test('send comments passes the pins\' anchor states to the prompt route (only when there are any)', async () => {
  const s = setup({ session: { id: LINKED, title: 'Coffee', busy: false } });
  const before = s.service.requests.length;
  await s.flows.sendComments(COFFEE, undefined, { c_hero01: 'moved' });
  const prompt = s.service.requests.slice(before).find((request) => request.path.endsWith('/prompt'));
  assert.deepEqual(JSON.parse(prompt?.body ?? '{}'), { purpose: 'revision', anchorStates: { c_hero01: 'moved' } });

  const t = setup({ session: { id: LINKED, title: 'Coffee', busy: false } });
  const start = t.service.requests.length;
  await t.flows.sendComments(COFFEE, undefined, {});
  const plain = t.service.requests.slice(start).find((request) => request.path.endsWith('/prompt'));
  assert.deepEqual(JSON.parse(plain?.body ?? '{}'), { purpose: 'revision' });
});

test('send comments, branch 1 busy: composed + toast, still marked sent; SESSION_BUSY race also composes', async () => {
  const s = setup({ session: { id: LINKED, title: 'Coffee', busy: true } });
  const result = await s.flows.sendComments(COFFEE);
  assert.equal(result.outcome, 'composed');
  assert.deepEqual(s.host.callsOf('prompt').map(([request]) => (request as PromptRequest).send), [false]);
  assert.deepEqual(toasts(s), [MESSAGES.busy]);
  assert.equal(comments(s)[0]?.status, 'sent');

  const race = setup({ session: { id: LINKED, title: 'Coffee', busy: false } });
  race.host.behavior.prompt = async (request) => {
    if (request.send) throw new HostRequestError('SESSION_BUSY', 'busy');
    return { sent: 'skipped' };
  };
  assert.equal((await race.flows.sendComments(COFFEE)).outcome, 'composed');
  assert.deepEqual(race.host.callsOf('prompt').map(([request]) => (request as PromptRequest).send), [true, false]);
  assert.deepEqual(toasts(race), [MESSAGES.busy]);

  const failed = setup({ session: { id: LINKED, title: 'Coffee', busy: false } });
  failed.host.behavior.prompt = async () => ({ sent: 'no-model' });
  await assert.rejects(failed.flows.sendComments(COFFEE), (error: unknown) => error instanceof FlowError && error.code === 'send-failed');
  assert.equal(comments(failed)[0]?.status, 'open', 'not marked when nothing was sent');
});

test('send comments, branch 2: another chat selected → outbox, rail opened, openSession; comments stay open', async () => {
  const s = setup({ session: { id: 'ses_other', title: 'Other', busy: false } });
  s.host.behavior.openSurface = async () => {
    throw new HostRequestError('UNSUPPORTED', 'no rail here');
  };
  const result = await s.flows.sendComments(COFFEE);
  assert.equal(result.outcome, 'outbox');
  assert.equal(s.service.outbox?.sessionId, LINKED);
  assert.deepEqual(s.service.outbox?.commentIds, ['c_hero01']);
  assert.deepEqual(s.host.callsOf('openSurface'), [['plugin:design-chamber']]);
  assert.deepEqual(s.host.callsOf('openSession'), [[LINKED]]);
  assert.equal(s.host.callsOf('prompt').length, 0, 'the page never prompts a session it did not select');
  assert.equal(comments(s)[0]?.status, 'open');
});

test('outbox delivery: the rail delivers exactly once, only to the right session', async () => {
  const service = createFakeService();
  const page = setup({ service, surface: 'page', session: { id: 'ses_other', title: 'Other', busy: false } });
  await page.flows.sendComments(COFFEE);
  assert.ok(service.outbox);

  // Two rail frames (e.g. two windows) see the same session at once.
  const railA = setup({ service, surface: 'panel', session: null });
  const railB = setup({ service, surface: 'panel', session: null });
  const stopA = railA.flows.watchOutbox();
  const stopB = railB.flows.watchOutbox();

  // A different session selected: nothing is taken.
  railA.host.setSession({ id: 'ses_other', title: 'Other', busy: false });
  await tick();
  assert.ok(service.outbox, 'outbox for another session stays');

  railA.host.setSession({ id: LINKED, title: 'Coffee', busy: false });
  railB.host.setSession({ id: LINKED, title: 'Coffee', busy: false });
  await until(() => comments(page)[0]?.status === 'sent', 'comment marked sent');
  await tick();
  const prompts = [...railA.host.callsOf('prompt'), ...railB.host.callsOf('prompt')];
  assert.equal(prompts.length, 1, 'delivered exactly once');
  assert.equal((prompts[0]?.[0] as PromptRequest).send, true);
  assert.equal(service.outbox, null);

  // Selecting the session again later delivers nothing more.
  railA.host.setSession({ id: 'ses_other', title: 'Other', busy: false });
  railA.host.setSession({ id: LINKED, title: 'Coffee', busy: false });
  await tick();
  assert.equal(railA.host.callsOf('prompt').length + railB.host.callsOf('prompt').length, 1);
  stopA();
  stopB();
});

test('outbox delivery: an outbox older than 10 minutes is ignored; busy delivery composes', async () => {
  const service = createFakeService();
  const created = '2026-10-26T18:00:00.000Z';
  service.outbox = { sessionId: LINKED, slug: COFFEE, text: 'Revise', commentIds: ['c_hero01'], version: 1, created };
  const late = setup({ service, surface: 'panel' }, () => Date.parse(created) + 11 * 60_000);
  assert.equal(await late.flows.deliverOutbox({ id: LINKED, title: 'Coffee', busy: false }), 'none');
  assert.ok(service.outbox);

  const busy = setup({ service, surface: 'panel', session: { id: LINKED, title: 'Coffee', busy: true } }, () => Date.parse(created) + 60_000);
  assert.equal(await busy.flows.deliverOutbox({ id: LINKED, title: 'Coffee', busy: true }), 'composed');
  assert.deepEqual(toasts(busy), [MESSAGES.busy]);
  assert.equal(service.outbox, null);
});

test('send comments, branch 2 → 3: the linked session is gone → outbox taken back, new chat', async () => {
  const s = setup({ knownSessions: [], session: { id: 'ses_other', title: 'Other', busy: false } });
  const result = await s.flows.sendComments(COFFEE);
  assert.equal(result.outcome, 'new-session');
  assert.equal(s.service.outbox, null);
  const [request] = s.host.callsOf('startSession')[0] as [StartSessionRequest];
  assert.match(request.text ?? '', /Revise/);
  assert.equal(request.id, `design:${COFFEE}`);
  assert.equal(s.service.designs.get(COFFEE)?.design.sessionId, result.sessionId);
  assert.equal(comments(s)[0]?.status, 'sent');
});

test('send comments, branch 3: no linked session → new chat; nothing open → nothing', async () => {
  const s = setup();
  const coffee = s.service.designs.get(COFFEE);
  assert.ok(coffee);
  coffee.design.sessionId = null;
  const result = await s.flows.sendComments(COFFEE);
  assert.equal(result.outcome, 'new-session');
  assert.equal(s.host.callsOf('openSession').length, 0);
  assert.equal(comments(s)[0]?.status, 'sent');

  const again = await s.flows.sendComments(COFFEE);
  assert.equal(again.outcome, 'nothing');
  assert.equal(s.host.callsOf('startSession').length, 1);
});

// ---- §10.5 reconciliation ----

const record = (id: string, updatedAt: number, slugs: string[], activity: GuestSessionRecord['activity'] = 'idle'): GuestSessionRecord => ({
  id,
  title: id,
  projectId: 'proj_shop',
  directory: 'C:\\Users\\you\\projects\\shop',
  parentId: null,
  createdAt: 0,
  updatedAt,
  archivedAt: null,
  worktree: null,
  activity,
  outcome: null,
  items: slugs.map((slug) => ({ id: `design:${slug}`, data: { slug, kind: 'canvas' } })),
});

test('planReconciliation picks the newest session carrying the chip, only for unlinked or gone links', () => {
  const snapshot = {
    kind: 'sessions' as const,
    projectId: 'proj_shop',
    state: 'ready' as const,
    coverage: [],
    sessions: [record('ses_old', 100, ['a', 'b', 'c']), record('ses_new', 300, ['a', 'b']), record('ses_mid', 200, ['a', 'd']), { ...record('ses_x', 999, []), items: [{ id: 'other:thing' }] }],
  };
  const designs = [
    { slug: 'a', sessionId: null },
    { slug: 'b', sessionId: 'ses_deleted' },
    { slug: 'c', sessionId: 'ses_mid' },
    { slug: 'd', sessionId: 'ses_mid' },
    { slug: 'e', sessionId: null },
  ];
  assert.deepEqual(planReconciliation(snapshot, designs), [
    { slug: 'a', sessionId: 'ses_new' },
    { slug: 'b', sessionId: 'ses_new' },
  ]);
  assert.deepEqual(planReconciliation({ ...snapshot, state: 'loading' }, designs), []);
});

test('watchSessions subscribes for the current project and PATCHes repaired links', async () => {
  const s = setup();
  const stop = s.flows.watchSessions(() => [{ slug: 'launch-announcement', sessionId: null }]);
  await tick();
  s.host.emitSessions('proj_shop', [record('ses_a', 10, ['launch-announcement']), record('ses_b', 20, ['launch-announcement'])]);
  await until(() => s.service.designs.get('launch-announcement')?.design.sessionId === 'ses_b', 'link patched');
  stop();
  assert.ok(sameDirectory('C:\\A\\b\\', 'c:/a/B'));
  assert.ok(!sameDirectory('/home/a', '/home/A'));
});

// ---- §10.6 turn snapshots ----

test('turn snapshots: a linked chat that is not selected gets one when its turn ends (smoke m5)', async () => {
  const s = setup({ session: { id: 'ses_other', title: 'Other', busy: false } });
  const stop = s.flows.watchSessions(() => [{ slug: COFFEE, sessionId: LINKED }]);
  await tick();
  const start = s.service.requests.length;
  s.host.emitSessions('proj_shop', [record(LINKED, 10, [COFFEE], 'running'), record('ses_unlinked', 10, [], 'running')]);
  await tick();
  assert.deepEqual(routes(s, start).filter((route) => route === 'POST /versions/turn'), [], 'nothing while it works');
  s.host.emitSessions('proj_shop', [record(LINKED, 20, [COFFEE], 'idle'), record('ses_unlinked', 20, [], 'idle')]);
  await until(() => routes(s, start).includes('POST /versions/turn'), 'turn snapshot');
  const body = JSON.parse(s.service.requests.filter((request) => request.path === '/versions/turn').at(-1)?.body ?? '{}');
  assert.deepEqual(body, { sessionId: LINKED });
  assert.equal(routes(s, start).filter((route) => route === 'POST /versions/turn').length, 1, 'only the linked chat');
  stop();
});

test('turn snapshots: started → completed → POST /versions/turn, deduped per session for 2 s', async () => {
  let clock = 1_000_000;
  const s = setup({}, () => clock);
  const stop = s.flows.watchTurns();
  const start = s.service.requests.length;
  // The host says "completed" for an idle chat it merely shows (mount, chat switch): no turn.
  s.host.emitLifecycle({ sessionId: LINKED, phase: 'completed' });
  await tick();
  assert.deepEqual(routes(s, start), []);
  s.host.emitLifecycle({ sessionId: LINKED, phase: 'started' });
  s.host.emitLifecycle({ sessionId: LINKED, phase: 'completed' });
  s.host.emitLifecycle({ sessionId: LINKED, phase: 'started' });
  s.host.emitLifecycle({ sessionId: LINKED, phase: 'completed' });
  clock += 2500;
  s.host.emitLifecycle({ sessionId: LINKED, phase: 'started' });
  s.host.emitLifecycle({ sessionId: LINKED, phase: 'completed' });
  s.host.emitLifecycle({ sessionId: 'ses_other', phase: 'started' });
  s.host.emitLifecycle({ sessionId: 'ses_other', phase: 'failure' });
  await tick();
  assert.deepEqual(routes(s, start), ['POST /versions/turn', 'POST /versions/turn']);
  stop();
});

// ---- §10.7 / §10.8 items ----

const message = (text: string): GuestMessageItem => ({
  kind: 'message',
  action: 'open-as-artifact',
  sessionId: 'ses_msg',
  sessionTitle: 'Landing ideas',
  directory: 'C:\\Users\\you\\projects\\shop',
  messageId: 'msg_1',
  role: 'assistant',
  text,
});

test('open as artifact: the HTML block becomes an artifact linked to the message session', async () => {
  const s = setup({ surface: 'panel' });
  const html = `<!doctype html><html><head><title>Hero idea</title></head><body>${'é😀'.repeat(40_000)}</body></html>`;
  const created = await s.flows.openAsArtifact(message(`Here you go:\n\n\`\`\`html\n${html}\n\`\`\`\nEnjoy.`));
  assert.ok(created);
  const design = s.service.designs.get(created.slug);
  assert.equal(design?.design.kind, 'artifact');
  assert.equal(design?.design.sessionId, 'ses_msg');
  assert.equal(design?.design.title, 'Hero idea');
  assert.equal(design?.files['index.html'], `${html}\n`);
});

test('open as artifact: no HTML block → toast, nothing created, nothing uploaded', async () => {
  const s = setup({ surface: 'panel' });
  const count = s.service.designs.size;
  const before = s.service.requests.length;
  assert.equal(await s.flows.openAsArtifact(message('Just prose, and `inline <b>code</b>`.')), null);
  assert.deepEqual(toasts(s), [MESSAGES.noHtml]);
  assert.equal(s.service.designs.size, count);
  assert.deepEqual(routes(s, before), [], 'answered in the guest, before any upload');
});

test('open as artifact: the service 422 no-html stays the authority', async () => {
  const s = setup({ surface: 'panel' });
  // The guest finds a block the (stricter) fake service does not accept: the service's answer wins.
  assert.equal(await s.flows.openAsArtifact(message('```\n<!doctype html><html><body>x</body></html>\n```')), null);
  assert.deepEqual(toasts(s), [MESSAGES.noHtml]);
});

test('open as artifact (background action): saves, leaves an open request, opens the rail, confirms with a host toast', async () => {
  const bg = setup({ surface: 'background' });
  await bg.flows.runAction(message('```html\n<html><title>Bike card</title></html>\n```'));
  assert.deepEqual(bg.host.callsOf('openSurface'), [['plugin:design-chamber']]);
  assert.deepEqual(toasts(bg), [MESSAGES.savedArtifact('Bike card')]);
  const body = JSON.parse(bg.service.requests.find((request) => request.path === '/artifacts/from-message')?.body ?? '{}');
  assert.equal(body.open, true);

  // The rail (same service) takes the request once, on mount, and opens the viewer.
  const rail = createFlows({ host: createFakeServices({ service: bg.service, surface: 'panel' }).guestHost, client: bg.client });
  const opened: string[] = [];
  let added: (() => void) | null = null;
  const stop = rail.watchOpenRequests((listener) => {
    added = listener;
    return () => (added = null);
  }, (target) => opened.push(target.slug));
  await until(() => opened.length === 1, 'rail opened the artifact');
  assert.equal(bg.service.designs.get(opened[0] ?? '')?.design.title, 'Bike card');
  // Already open: an `added` change makes it look again; a taken request never opens twice.
  (added as (() => void) | null)?.();
  await tick();
  assert.equal(opened.length, 1);
  await bg.flows.runAction({ ...message('```html\n<html><title>Second card</title></html>\n```'), messageId: 'msg_2' });
  (added as (() => void) | null)?.();
  await until(() => opened.length === 2, 'second artifact opened in the open rail');
  stop();
});

test('open as artifact (background action): no side panel → the toast says where to find it; no HTML → no panel', async () => {
  const s = setup({ surface: 'background' });
  s.host.behavior.openSurface = async () => {
    throw new HostRequestError('UNSUPPORTED', 'This OpenChamber surface has no side panel.');
  };
  await s.flows.runAction(message('```html\n<html><title>Card</title></html>\n```'));
  assert.deepEqual(toasts(s), [MESSAGES.savedArtifactClosed('Card')]);

  const t = setup({ surface: 'background' });
  await t.flows.runAction(message('No code here.'));
  assert.deepEqual(toasts(t), [MESSAGES.noHtml]);
  assert.deepEqual(t.host.callsOf('openSurface'), []);
  // Other actions are not ours to run.
  await t.flows.runAction({ ...message('```html\n<html></html>\n```'), action: 'something-else' });
  assert.deepEqual(t.host.callsOf('openSurface'), []);
});

test('items: our chip opens its design; foreign chips and bad slugs are ignored; replays are deduped', async () => {
  const s = setup({ surface: 'panel' });
  const chip = { providerId: 'design-chamber', id: `design:${COFFEE}`, title: 'Coffee', url: '', data: { slug: COFFEE, kind: 'canvas' } };
  assert.deepEqual(await s.flows.handleItem(chip), { kind: 'open-design', slug: COFFEE });
  assert.equal(await s.flows.handleItem({ ...chip, providerId: 'linear' }), null);
  assert.equal(await s.flows.handleItem({ ...chip, data: { slug: '../etc' } }), null);
  assert.equal(await s.flows.handleItem(null), null);

  const opened: string[] = [];
  const stop = s.flows.watchItems((target) => opened.push(target.slug));
  s.host.setItem(chip);
  s.host.emitReady({ item: chip });
  s.host.setItem(chip);
  await tick();
  assert.deepEqual(opened, [COFFEE]);
  s.host.setItem(message('```html\n<html><title>From chat</title></html>\n```'));
  s.host.setItem(message('```html\n<html><title>From chat</title></html>\n```'));
  await until(() => opened.length === 2, 'artifact opened');
  await tick();
  assert.equal(opened.length, 2, 'the same message never creates two artifacts');
  stop();
});

test('host wrapper: observables replay, whenReady resolves on the first snapshot', async () => {
  const fakes = createFakeServices({ session: { id: 's1', title: 'One', busy: false } });
  const host = createGuestHost(fakes.host);
  const seen: (string | null)[] = [];
  host.session.subscribe((session) => seen.push(session?.id ?? null));
  const ready = host.whenReady();
  fakes.host.emitReady({ surface: 'panel' });
  assert.equal((await ready).surface, 'panel');
  fakes.host.setSession({ id: 's1', title: 'One', busy: false });
  fakes.host.setSession({ id: 's2', title: 'Two', busy: true });
  assert.deepEqual(seen, ['s1', 's2']);
  host.dispose();
});
