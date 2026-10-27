// Starts the panel + page UI on a guest host and service client (docs/SPEC.md §8.1): applies the
// host theme on every `ready` snapshot (so a theme switch repaints live) and routes by
// `ready.surface`: `panel` → the rail app, `page` → the full-screen page app. This frame never
// registers `onResolve` — the background entry answers slash commands.

import { applyHostReady, mountSpinner } from '@openchamber/sdk/ui';

import type { GuestHost } from '../guest/host.ts';
import type { ServiceClient } from '../guest/service-client.ts';
import { flows, host, startGuest, store } from './guest.ts';
import { mountPage } from './page/page-app.ts';
import { mountRail } from './rail/rail-app.ts';

export const startApp = (guestHost: GuestHost, client: ServiceClient): void => {
  const root = document.querySelector<HTMLElement>('#root');
  if (!root) throw new Error('Design Chamber: #root is missing from index.html.');
  const appRoot: HTMLElement = root;

  startGuest(guestHost, client);

  // The controls we draw by hand (`oc-sdk-btn`, `oc-sdk-popup`) use the kit's classes; mounting any
  // kit primitive injects the kit stylesheet, so do it once before the first screen paints.
  mountSpinner(document.createElement('div')).dispose();

  let mounted = false;

  host.onReady((context) => {
    if (context.surface === 'background') return;
    applyHostReady(context, document.documentElement);
    document.documentElement.lang = context.locale;
    if (mounted) return;
    mounted = true;
    if (context.surface === 'page') mountPage(appRoot);
    else {
      mountRail(appRoot);
      flows.watchOutbox();
    }
    flows.watchTurns();
    flows.watchSessions(() => (store.getState().designs.data?.designs ?? []).map(({ slug, sessionId }) => ({ slug, sessionId })));
  });
};
