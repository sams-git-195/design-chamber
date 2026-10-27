// Hidden background frame: answers the /design and /artifact slash commands (docs/SPEC.md
// §8.1, §10.1) and runs the "Open as artifact" message action (§10.8). Both handlers are
// registered synchronously after connecting (the host waits up to 20 s, F15); `POST /chip`
// creates the pending design and returns the chip. A thrown error's message is what the host
// shows the user.

import { getGuestHost } from './host.ts';
import { createFlows } from './flows.ts';
import { createServiceClient } from './service-client.ts';

/** How long a command waits for the first ready snapshot (directory + session) before going without. */
const READY_WAIT_MS = 2000;

const host = getGuestHost();
const flows = createFlows({ host, client: createServiceClient(host.client) });

host.client.onResolve(async (request) => {
  await Promise.race([host.whenReady(), new Promise((resolve) => setTimeout(resolve, READY_WAIT_MS))]);
  return flows.resolveSlashCommand(request);
});

host.client.onAction((item) => flows.runAction(item));
