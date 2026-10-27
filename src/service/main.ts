// Design Chamber local service entry (docs/SPEC.md §9.7). The host spawns this file with
// OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN (GUEST_SERVICES.md), proxies the
// guests' `serviceRequest` calls to it, and polls GET /health until 200.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { composeService, type ComposedService } from './compose.ts';
import { createLogger } from './context.ts';
import { createServiceServer, listenLoopback } from './http.ts';

const log = createLogger();

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!Number.isInteger(port) || port <= 0 || port > 65_535 || token.length === 0) {
  log.error('service.env-missing', { message: 'OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required.' });
  process.exit(1);
}

// dist/service/main.js (and src/service/main.ts in tests) sit two levels below the package root.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const readVersion = (): string => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed && typeof parsed.version === 'string') return parsed.version;
  } catch (error) {
    log.warn('service.version-unreadable', { error: error instanceof Error ? error.message : String(error) });
  }
  return '0.0.0';
};

process.on('unhandledRejection', (error) => {
  log.error('service.unhandled-rejection', { error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
});

let service: ComposedService;
try {
  service = await composeService({ token, log, packageRoot, version: readVersion() });
} catch (error) {
  log.error('service.start-failed', { error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  process.exit(1);
}

const server = createServiceServer(service.router);

let stopping = false;
const shutdown = async (reason: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  log.info('service.stopping', { reason });
  server.close();
  await service.dispose();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await listenLoopback(server, port);
  log.info('service.ready', { port, version: service.ctx.version });
} catch (error) {
  log.error('service.listen-failed', { port, error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}
