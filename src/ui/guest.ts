// The UI's one door to the guest core (docs/GUEST-API.md): the frame's host connection, service
// client, store and flows. The entry calls `startGuest` once, before any view mounts —
// `src/ui/main.ts` with the real host, the visual harness (test/ui/visual) with a fake service.
// Views import the live bindings below and never call `connectHost()` themselves.

import type { HostReadyContext, SessionSnapshot, ToastRequest } from '@openchamber/sdk';

import { createChangeFeed, type ChangeFeed } from '../guest/changes.ts';
import { createFlows, type Flows } from '../guest/flows.ts';
import type { GuestHost } from '../guest/host.ts';
import type { ServiceClient } from '../guest/service-client.ts';
import { createStore, type Store } from '../guest/store.ts';

export { isServiceError, ServiceError } from '../guest/service-client.ts';
export type { HostReadyContext, SessionSnapshot };

export let guestHost!: GuestHost;
export let client!: ServiceClient;
export let store!: Store;
export let flows!: Flows;
export let feed!: ChangeFeed;

export const startGuest = (nextHost: GuestHost, nextClient: ServiceClient): void => {
  guestHost = nextHost;
  client = nextClient;
  store = createStore({ client });
  flows = createFlows({ host: guestHost, client });
  feed = createChangeFeed(client);
  store.connect(feed);
};

const swallow = (what: string) => (error: unknown): void => {
  console.warn(`Design Chamber: ${what} failed`, error);
};

/** Best-effort host calls: the UI treats toasts, links, clipboard and view prefs as optional, so these never reject. */
export const host = {
  snapshot: (): HostReadyContext | null => guestHost.ready.get(),
  session: (): SessionSnapshot | null => guestHost.session.get(),
  /** Every ready snapshot (theme switches included), starting with the current one. */
  onReady: (listener: (context: HostReadyContext) => void): (() => void) =>
    guestHost.ready.subscribe((context) => {
      if (context) listener(context);
    }),
  toast: (request: ToastRequest): Promise<void> => guestHost.client.toast(request).catch(swallow('toast')),
  openUrl: (url: string): Promise<void> => guestHost.client.openUrl(url).catch(swallow('openUrl')),
  writeClipboard: (text: string): Promise<boolean> =>
    guestHost.client.writeClipboard(text).then(
      () => true,
      (error: unknown) => {
        swallow('writeClipboard')(error);
        return false;
      },
    ),
  storage: {
    get: (key: string): Promise<unknown> => guestHost.client.storage.get(key).catch(() => undefined),
    set: (key: string, value: string | number | boolean | null | object): Promise<void> =>
      // Safe: callers pass plain JSON; the host rejects anything else and the error is swallowed.
      guestHost.client.storage.set(key, value as Parameters<GuestHost['client']['storage']['set']>[1]).catch(swallow('storage.set')),
  },
};

const SELF_CONTAINED_REQUEST =
  'This design references files on the internet (scripts, styles, fonts or images), which are blocked inside Design Chamber. Make it self-contained: download or inline every remote file into assets/ (or inline it), and point to it with a relative path.';

/**
 * §10.7 "Ask the agent to make it self-contained": puts the request in the linked chat's
 * composer (the user sends it), starting a linked chat first when there is none.
 */
export const askSelfContained = async (slug: string): Promise<void> => {
  const { design } = await client.call('GET /designs/:slug', { params: { slug } });
  if (design.sessionId === null) await flows.continueInChat(slug);
  else if (guestHost.session.get()?.id !== design.sessionId) await guestHost.client.openSession(design.sessionId);
  await guestHost.client.compose({ text: SELF_CONTAINED_REQUEST, mode: 'append' });
};
