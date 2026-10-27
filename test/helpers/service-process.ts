// Start the real service the way the host does (GUEST_SERVICES.md): a child process with
// OPENCHAMBER_SERVICE_PORT + OPENCHAMBER_SERVICE_TOKEN, ready once GET /health answers 200
// with the bearer. Runs src/service/main.ts directly (Node strips the types), or the built
// dist/service/main.js when asked. Unless the caller passes DC_SETTINGS_PATH, the process gets
// its own settings file and designs root in a tmp folder, so a test never reads or watches the
// user's real ~/Documents/Designs.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';

export const SOURCE_MAIN = path.resolve(import.meta.dirname, '..', '..', 'src', 'service', 'main.ts');
export const BUILT_MAIN = path.resolve(import.meta.dirname, '..', '..', 'dist', 'service', 'main.js');
const READY_TIMEOUT_MS = 15_000;

export type ServiceRequest = {
  method?: string;
  query?: Record<string, string>;
  /** Sent as the JSON body string, exactly like the host proxy. */
  body?: unknown;
  /** `undefined` = the right token; `null` = no Authorization header; a string = that token. */
  token?: string | null;
};

export type RunningService = {
  port: number;
  token: string;
  request(pathname: string, init?: ServiceRequest): Promise<Response>;
  /** Everything the process wrote to stderr/stdout so far. */
  output(): string;
  stop(): Promise<void>;
};

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });

/** A tmp settings file whose root is a tmp designs folder; removed by the returned cleanup. */
const isolatedSettings = async (): Promise<{ env: Record<string, string>; cleanup: () => Promise<void> }> => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dc-service-')));
  const root = path.join(dir, 'designs');
  await mkdir(root, { recursive: true });
  const settingsPath = path.join(dir, 'settings.json');
  await writeFile(settingsPath, `${JSON.stringify({ version: 1, root, downloadsDir: path.join(dir, 'downloads') })}
`, 'utf8');
  return { env: { DC_SETTINGS_PATH: settingsPath }, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 3 }) };
};

export const startServiceProcess = async (env: Record<string, string> = {}, main: string = SOURCE_MAIN): Promise<RunningService> => {
  const port = await freePort();
  const token = randomBytes(24).toString('hex');
  const isolated = env.DC_SETTINGS_PATH ? null : await isolatedSettings();
  const child = spawn(process.execPath, [main], {
    env: { ...process.env, ...isolated?.env, ...env, OPENCHAMBER_SERVICE_PORT: String(port), OPENCHAMBER_SERVICE_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  let exited = false;
  const exit = new Promise<void>((resolve) => child.once('exit', () => ((exited = true), resolve())));

  const request = (pathname: string, init: ServiceRequest = {}): Promise<Response> => {
    const url = new URL(pathname, `http://127.0.0.1:${port}`);
    for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = {};
    const bearer = init.token === undefined ? token : init.token;
    if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    return fetch(url, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
  };

  const stop = async (): Promise<void> => {
    if (!exited) child.kill();
    await exit;
    await isolated?.cleanup();
  };

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) {
      await isolated?.cleanup();
      throw new Error(`The service exited before it was ready:\n${output}`);
    }
    const answer = await request('/health').catch(() => null);
    if (answer?.status === 200) return { port, token, request, output: () => output, stop };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await stop();
  throw new Error(`The service did not answer /health within ${READY_TIMEOUT_MS} ms:\n${output}`);
};

/** `startServiceProcess`, stopped automatically when the test ends. */
export const useServiceProcess = async (t: TestContext, env?: Record<string, string>, main?: string): Promise<RunningService> => {
  const service = await startServiceProcess(env, main);
  t.after(() => service.stop());
  return service;
};
