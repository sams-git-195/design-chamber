// Page side of the bridge channel (docs/SPEC.md §4.2, §8.3). One channel per artboard document.
//
// A frame message is accepted only when (1) `event.source` is exactly this artboard's
// `contentWindow`, (2) the shape passes `parseFrameMessage`, and (3) its `artboardId` and
// `nonce` are the ones this document was built with. Everything accepted is still advisory:
// the design runs in the bridge's realm and can forge any of it.

import {
  BRIDGE_PROTOCOL_VERSION,
  parseFrameMessage,
  type FrameToPageMessage,
  type PageToFrameMessage,
} from '../shared/bridge-protocol.ts';

type Envelope = 'dc' | 'artboardId' | 'nonce';
/** A page → frame message without its envelope; `send` adds it. */
export type PageMessageBody = PageToFrameMessage extends infer M ? (M extends unknown ? Omit<M, Envelope> : never) : never;

export type FrameIdentity = { artboardId: string; nonce: string };

/** The validation step, pure: the message, or null when it must be ignored. */
export const acceptFrameMessage = (
  event: { readonly source: unknown; readonly data: unknown },
  expectedSource: unknown,
  identity: FrameIdentity,
): FrameToPageMessage | null => {
  if (expectedSource === null || expectedSource === undefined || event.source !== expectedSource) return null;
  const message = parseFrameMessage(event.data);
  if (!message || message.artboardId !== identity.artboardId || message.nonce !== identity.nonce) return null;
  return message;
};

export type MessageTargetLike = { postMessage(message: unknown, targetOrigin: string): void };

export type MessageSourceLike = {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
};

export type FrameChannel = {
  readonly identity: FrameIdentity;
  /** Post to the artboard frame (opaque origin, so `'*'` is the only target that works). */
  send(body: PageMessageBody): void;
  /** Validated frame messages; returns the unsubscribe function. */
  subscribe(listener: (message: FrameToPageMessage) => void): () => void;
  dispose(): void;
};

export type FrameChannelOptions = FrameIdentity & {
  /** The artboard `<iframe>`; read on every event because `contentWindow` changes on reload. */
  frame: { readonly contentWindow: MessageTargetLike | null };
  /** Where `message` events arrive; defaults to `window`. */
  window?: MessageSourceLike;
};

export const createFrameChannel = (options: FrameChannelOptions): FrameChannel => {
  const identity: FrameIdentity = { artboardId: options.artboardId, nonce: options.nonce };
  const target: MessageSourceLike = options.window ?? window;
  const listeners = new Set<(message: FrameToPageMessage) => void>();
  let disposed = false;

  const onMessage = (event: MessageEvent): void => {
    const message = acceptFrameMessage(event, options.frame.contentWindow, identity);
    if (!message) return;
    if (message.type === 'ready') send({ type: 'init-ack' });
    for (const listener of [...listeners]) listener(message);
  };

  const send = (body: PageMessageBody): void => {
    if (disposed) return;
    options.frame.contentWindow?.postMessage({ ...body, dc: BRIDGE_PROTOCOL_VERSION, ...identity }, '*');
  };

  target.addEventListener('message', onMessage);
  return {
    identity,
    send,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => {
      disposed = true;
      listeners.clear();
      target.removeEventListener('message', onMessage);
    },
  };
};
