// Visual harness entry (shoot.mjs bundles it in place of src/ui/main.ts): the real UI on the
// real guest core, talking to the mock host page for theme, toasts, clipboard and storage, with
// service requests answered in memory by the fake backend. Never part of a production bundle.

import { connectHost } from '@openchamber/sdk';

import { createGuestHost, type HostLike } from '../../../src/guest/host.ts';
import { createServiceClient } from '../../../src/guest/service-client.ts';
import { startApp } from '../../../src/ui/app.ts';
import { createFakeTransport } from './fake-transport.ts';

const real = connectHost();
const fake = createFakeTransport();
const hybrid: HostLike = new Proxy(real, {
  get: (target, key, receiver) => (key === 'serviceRequest' ? fake.serviceRequest : Reflect.get(target, key, receiver)),
});
const guestHost = createGuestHost(hybrid);
startApp(guestHost, createServiceClient(fake));

/** Hook for shoot.mjs: the agent finishes the pending sample design. */
(window as unknown as { __dcFake?: { writePending: () => void } }).__dcFake = { writePending: fake.backend.writePending };
