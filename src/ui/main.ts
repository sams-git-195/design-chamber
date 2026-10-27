// Panel + page entry (docs/SPEC.md §8.1): the frame's one host connection and its service
// client. Everything else starts in `app.ts`.

import { getGuestHost } from '../guest/host.ts';
import { createServiceClient } from '../guest/service-client.ts';
import { startApp } from './app.ts';

const guestHost = getGuestHost();
startApp(guestHost, createServiceClient(guestHost.client));
