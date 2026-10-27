// The single host connection of a frame (docs/SPEC.md §8.2): wraps the SDK `HostClient` and
// exposes ready / session / directory / item as observables plus the lifecycle stream.
// Everything else in the guest core takes a `GuestHost`, so tests and UI development can pass
// a fake (`fake-services.ts`) instead of a real host.

import {
  connectHost,
  type GuestItem,
  type HostClient,
  type HostReadyContext,
  type SessionLifecycleEvent,
  type SessionSnapshot,
} from '@openchamber/sdk';

/** The host methods Design Chamber uses. A real `HostClient` satisfies it; so does the fake. */
export type HostLike = Pick<
  HostClient,
  | 'onReady'
  | 'onSession'
  | 'onDirectory'
  | 'onItem'
  | 'onSessionLifecycle'
  | 'onResolve'
  | 'onAction'
  | 'serviceRequest'
  | 'listProjects'
  | 'onSessions'
  | 'openSession'
  | 'openSurface'
  | 'startSession'
  | 'prompt'
  | 'compose'
  | 'attach'
  | 'toast'
  | 'openUrl'
  | 'writeClipboard'
  | 'close'
  | 'storage'
>;

/** A value that changes over time. `subscribe` calls the listener now and on every change. */
export type Observable<T> = { get(): T; subscribe(listener: (value: T) => void): () => void };

export type ObservableSource<T> = Observable<T> & { set(value: T): void };

export const createObservable = <T>(initial: T, equals: (a: T, b: T) => boolean = Object.is): ObservableSource<T> => {
  let value = initial;
  const listeners = new Set<(value: T) => void>();
  return {
    get: () => value,
    set: (next) => {
      if (equals(value, next)) return;
      value = next;
      for (const listener of [...listeners]) listener(next);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      listener(value);
      return () => listeners.delete(listener);
    },
  };
};

const sameSession = (a: SessionSnapshot | null, b: SessionSnapshot | null): boolean =>
  a === b || (a !== null && b !== null && a.id === b.id && a.busy === b.busy && a.title === b.title);

export type GuestHost = {
  /** The raw host methods (prompt, startSession, toast, storage, …). */
  readonly client: HostLike;
  /** Latest ready snapshot (theme, surface, directory, session, item); null before the first. */
  readonly ready: Observable<HostReadyContext | null>;
  readonly session: Observable<SessionSnapshot | null>;
  readonly directory: Observable<string | null>;
  /** The item this surface was opened for (our chip, or a message for "Open as artifact"). */
  readonly item: Observable<GuestItem | null>;
  onLifecycle(listener: (event: SessionLifecycleEvent) => void): () => void;
  /** Resolves with the first ready snapshot. */
  whenReady(): Promise<HostReadyContext>;
  dispose(): void;
};

export const createGuestHost = (client: HostLike): GuestHost => {
  const ready = createObservable<HostReadyContext | null>(null);
  const session = createObservable<SessionSnapshot | null>(null, sameSession);
  const directory = createObservable<string | null>(null);
  const item = createObservable<GuestItem | null>(null);
  const lifecycle = new Set<(event: SessionLifecycleEvent) => void>();
  const readyWaiters: ((context: HostReadyContext) => void)[] = [];

  const unsubscribers = [
    client.onReady((context) => {
      ready.set(context);
      session.set(context.session);
      directory.set(context.directory);
      if (context.item !== null) item.set(context.item);
      for (const resolve of readyWaiters.splice(0)) resolve(context);
    }),
    client.onSession((next) => session.set(next)),
    client.onDirectory((next) => directory.set(next)),
    client.onItem((next) => item.set(next)),
    client.onSessionLifecycle((event) => {
      for (const listener of [...lifecycle]) listener(event);
    }),
  ];

  return {
    client,
    ready,
    session,
    directory,
    item,
    onLifecycle: (listener) => {
      lifecycle.add(listener);
      return () => lifecycle.delete(listener);
    },
    whenReady: () => {
      const current = ready.get();
      return current ? Promise.resolve(current) : new Promise((resolve) => readyWaiters.push(resolve));
    },
    dispose: () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      lifecycle.clear();
    },
  };
};

let shared: GuestHost | null = null;

/** The frame's one host connection (`connectHost()` on first use). */
export const getGuestHost = (): GuestHost => {
  shared ??= createGuestHost(connectHost());
  return shared;
};
