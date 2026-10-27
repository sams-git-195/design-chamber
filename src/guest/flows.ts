// Chat linkage flows (docs/SPEC.md §10): slash-command chips, new design, continue in chat,
// send comments (incl. the outbox for a session that is not selected), session
// reconciliation, turn snapshots, "Open as artifact", and chip clicks.
//
// Host constraints these flows are shaped by: `prompt` acts on the selected session only
// (F13); `openSession` closes the page and throws NO_SESSION for an unknown id (F12);
// `startSession` needs a project (F14). The service is the source of truth for designs;
// the host is the source of truth for sessions.

import {
  HostRequestError,
  isGuestAttachItem,
  type GuestActionItem,
  isGuestMessageItem,
  type AttachIssueRequest,
  type GuestItem,
  type GuestMessageItem,
  type GuestSessionsSnapshot,
  type PromptResult,
  type ResolveRequest,
  type SessionSnapshot,
} from '@openchamber/sdk';

import { extractHtml } from '../shared/agent/html-extract.ts';
import type { PromptBody } from '../shared/api.ts';
import type { AnchorState, DesignChip, DesignKind, Outbox } from '../shared/types.ts';
import { CHIP_PROVIDER_ID } from '../shared/types.ts';
import { OUTBOX_TTL_MS, SLUG_PATTERN, TURN_SNAPSHOT_DEDUPE_MS } from '../shared/limits.ts';
import type { GuestHost } from './host.ts';
import { isServiceError, type ServiceClient } from './service-client.ts';

export const PANEL_SURFACE_ID = `plugin:${CHIP_PROVIDER_ID}`;
export const OPEN_AS_ARTIFACT_ACTION = 'open-as-artifact';
export const CHIP_ID_PREFIX = 'design:';

export const MESSAGES = {
  noProject: 'Open a project first, then try again.',
  busy: 'Agent is busy — revision placed in the composer',
  noHtml: 'No HTML code block in this message',
  startFailed: "Couldn't start a chat for this design. It is in your Designs list; try Continue in chat.",
  sendFailed: "The revision didn't reach the chat. Your comments are still open; try again.",
  nothingToSend: 'There are no open comments to send.',
  unknownCommand: 'Design Chamber knows /design and /artifact only.',
  noSessionSelected: 'Open a chat first, then try again.',
  markFailed: 'Sent — but the comments could not be marked as sent. Resolve them by hand so they are not sent again.',
  savedArtifact: (title: string) => `Saved as artifact “${title}”.`,
  savedArtifactClosed: (title: string) => `Saved as artifact “${title}” — open Design Chamber to see it.`,
} as const;

export type FlowErrorCode = 'no-project' | 'start-failed' | 'send-failed' | 'nothing-to-send' | 'unknown-command' | 'no-session';

/** A flow that could not finish for a reason the user can act on; `message` is shown as is. */
export class FlowError extends Error {
  readonly code: FlowErrorCode;
  constructor(code: FlowErrorCode, message: string) {
    super(message);
    this.name = 'FlowError';
    this.code = code;
  }
}

export const isHostError = (error: unknown, code: string): boolean => error instanceof HostRequestError && error.code === code;

/** The chip as the SDK's attach request (our chip type is structurally one). */
export const toAttachRequest = (chip: DesignChip): AttachIssueRequest => ({
  providerId: chip.providerId,
  id: chip.id,
  title: chip.title,
  url: chip.url,
  text: chip.text,
  data: { slug: chip.data.slug, kind: chip.data.kind },
});

/** Folder paths from the host and from design.json, compared the way the OS would. */
export const sameDirectory = (a: string, b: string): boolean => {
  const norm = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '');
  const left = norm(a);
  const right = norm(b);
  const windows = /^[A-Za-z]:\//.test(left) || /^[A-Za-z]:\//.test(right);
  return windows ? left.toLowerCase() === right.toLowerCase() : left === right;
};

// ---- §10.5 reconciliation, pure ----

export type DesignLink = { slug: string; sessionId: string | null };

/**
 * Links to repair from one sessions snapshot: for each design whose chip (`design:<slug>`) is
 * on sessions of this project — when the design has no session, or its session is not in the
 * (ready) snapshot — link it to the newest such session by `updatedAt`.
 */
export const planReconciliation = (snapshot: GuestSessionsSnapshot, designs: readonly DesignLink[]): DesignLink[] => {
  if (snapshot.state !== 'ready') return [];
  const known = new Set(snapshot.sessions.map((session) => session.id));
  const newest = new Map<string, { id: string; updatedAt: number }>();
  for (const session of snapshot.sessions) {
    for (const item of session.items) {
      if (!item.id.startsWith(CHIP_ID_PREFIX)) continue;
      const slug = item.id.slice(CHIP_ID_PREFIX.length);
      const best = newest.get(slug);
      if (!best || session.updatedAt > best.updatedAt) newest.set(slug, { id: session.id, updatedAt: session.updatedAt });
    }
  }
  const patches: DesignLink[] = [];
  for (const design of designs) {
    const best = newest.get(design.slug);
    if (!best || best.id === design.sessionId) continue;
    if (design.sessionId === null || !known.has(design.sessionId)) patches.push({ slug: design.slug, sessionId: best.id });
  }
  return patches;
};

/**
 * Sessions whose turn just ended, from two consecutive snapshots: working before (running,
 * retrying or waiting on the user), idle now. Lets a frame snapshot the turn of a linked chat
 * that is not selected — `onSessionLifecycle` reports the frame's own session only (F18).
 */
export const finishedTurns = (previous: ReadonlyMap<string, string>, snapshot: GuestSessionsSnapshot): string[] => {
  if (snapshot.state !== 'ready') return [];
  return snapshot.sessions
    .filter((session) => session.activity === 'idle' && ['running', 'retrying', 'waiting-permission', 'waiting-question'].includes(previous.get(session.id) ?? ''))
    .map((session) => session.id);
};

// ---- Results ----

export type NewDesignInput = {
  kind: DesignKind;
  brief: string;
  preset?: string | null;
  /** `new-chat` (default in the dialog) starts a session; `current-chat` attaches to the selected one. */
  destination: 'new-chat' | 'current-chat';
};
export type NewDesignResult = { slug: string; sessionId: string | null };

export type ContinueResult = { outcome: 'opened' | 'new-session'; sessionId: string };

/**
 * `sent`: delivered to the selected chat · `composed`: the agent was busy, text is in the
 * composer · `outbox`: handed to the rail, which delivers after `openSession` · `new-session`:
 * a new chat was started with it · `nothing`: no open comments.
 */
export type SendCommentsOutcome = 'sent' | 'composed' | 'outbox' | 'new-session' | 'nothing';
/** `markFailed`: the chat got the revision but the comments are still `open` (KI-2) — never a send error. */
export type SendCommentsResult = { outcome: SendCommentsOutcome; sessionId: string | null; commentIds: string[]; omitted: string[]; markFailed?: true };

export type DeliverOutboxResult = 'delivered' | 'composed' | 'none';

/** What the surface should show for the item it was opened with. */
export type ItemTarget = { kind: 'open-design'; slug: string };

export type Flows = {
  /** Background frame: `/design <brief>` and `/artifact <brief>` → our chip. */
  resolveSlashCommand(request: ResolveRequest): Promise<AttachIssueRequest>;
  newDesign(input: NewDesignInput): Promise<NewDesignResult>;
  continueInChat(slug: string): Promise<ContinueResult>;
  /**
   * One revision request with the given (default: all open) comments. `anchorStates` comes from
   * the artboards' pin trackers (`anchorStatesOf`) so the prompt flags moved or missing elements.
   */
  sendComments(slug: string, commentIds?: string[], anchorStates?: Readonly<Record<string, AnchorState>>): Promise<SendCommentsResult>;
  /** Rail panel: deliver a waiting outbox to `session` when it is the one the outbox is for. */
  deliverOutbox(session?: SessionSnapshot | null): Promise<DeliverOutboxResult>;
  /** Patch every link `planReconciliation` finds; returns what was patched. */
  reconcile(snapshot: GuestSessionsSnapshot, designs: readonly DesignLink[]): Promise<DesignLink[]>;
  /** POST /versions/turn, deduped per session within TURN_SNAPSHOT_DEDUPE_MS. */
  snapshotTurn(sessionId: string): Promise<void>;
  /**
   * Message action: the message's HTML block becomes an artifact; null when it has none (toast
   * shown). `open` leaves an open request the rail takes (see `watchOpenRequests`).
   */
  openAsArtifact(item: GuestMessageItem, options?: { open?: boolean }): Promise<{ slug: string; title: string } | null>;
  /**
   * Background frame (`onAction`): "Open as artifact" saves the artifact, opens the rail (which
   * takes the open request and shows the viewer) and confirms with a host toast, so the user
   * sees the result whether or not the rail was open.
   */
  runAction(item: GuestActionItem): Promise<void>;
  /** Chip click or "Open as artifact": what to open, or null. */
  handleItem(item: GuestItem | null): Promise<ItemTarget | null>;

  /** Turn snapshots from `onSessionLifecycle` (every visible frame). */
  watchTurns(): () => void;
  /** Rail panel only: deliver the outbox when the matching session becomes selected (also on mount). */
  watchOutbox(): () => void;
  /**
   * Reconcile on mount and on every sessions snapshot of the current project; a linked chat
   * whose turn ends there gets its turn snapshot even when it is not the selected one.
   */
  watchSessions(designs: () => readonly DesignLink[]): () => void;
  /** Open what the surface was opened for (deduped: each chip/message once). */
  watchItems(open: (target: ItemTarget) => void, onError?: (error: unknown) => void): () => void;
  /**
   * Rail panel only: take the open request left by "Open as artifact" on mount and whenever a
   * design is added (the rail may already be open), and open it.
   */
  watchOpenRequests(onAdded: (listener: () => void) => () => void, open: (target: ItemTarget) => void): () => void;
};

export type FlowDeps = { host: GuestHost; client: ServiceClient; now?: () => number };

export const createFlows = ({ host, client, now = Date.now }: FlowDeps): Flows => {
  const api = host.client;
  const lastTurn = new Map<string, number>();
  let delivering = false;

  const toast = async (kind: 'info' | 'success' | 'error', message: string): Promise<void> => {
    try {
      await api.toast({ kind, message });
    } catch {
      // A toast that cannot show must not fail the flow it reports on.
    }
  };

  const latestVersion = async (slug: string): Promise<number | null> => {
    try {
      const { versions } = await client.call('GET /designs/:slug/versions', { params: { slug } });
      return versions.reduce<number | null>((max, version) => (max === null || version.n > max ? version.n : max), null);
    } catch {
      // The version number is a label on the sent comments, not a precondition.
      return null;
    }
  };

  /**
   * After the chat already has the revision: mark the comments sent, retrying once. A failure is
   * reported (false), never thrown — rejecting would invite a duplicate send (KI-2).
   */
  const markSent = async (slug: string, ids: string[], version: number | null): Promise<boolean> => {
    if (ids.length === 0) return true;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await client.call('POST /designs/:slug/comments/mark-sent', { params: { slug }, body: { ids, version } });
        return true;
      } catch {
        // Retried once below; then the caller tells the user to resolve them by hand.
      }
    }
    return false;
  };

  const projectIdFor = async (directory: string | null): Promise<string | undefined> => {
    if (!directory) return undefined;
    try {
      const { projects } = await api.listProjects();
      return projects.find((project) => sameDirectory(project.directory, directory))?.id;
    } catch {
      // Without the project list startSession falls back to the current project.
      return undefined;
    }
  };

  /** §10.4 step 1: prompt the selected session; busy → composer + toast. */
  const promptSelected = async (session: SessionSnapshot, text: string): Promise<'sent' | 'composed'> => {
    let result: PromptResult;
    if (session.busy) {
      await api.prompt({ text, send: false });
      await toast('info', MESSAGES.busy);
      return 'composed';
    }
    try {
      result = await api.prompt({ text, send: true });
    } catch (error) {
      if (!isHostError(error, 'SESSION_BUSY')) throw error;
      await api.prompt({ text, send: false });
      await toast('info', MESSAGES.busy);
      return 'composed';
    }
    if (result.sent === 'sent') return 'sent';
    throw new FlowError('send-failed', MESSAGES.sendFailed);
  };

  /** §10.4 step 3 / §10.3 fallback: a new chat carrying the design chip. */
  const startLinkedSession = async (slug: string, chip: DesignChip, text: string, projectDirectory: string | null) => {
    // The design's own project when the host knows it, else the current one (§10.3).
    const projectId = (await projectIdFor(projectDirectory)) ?? (await projectIdFor(host.directory.get()));
    if (!projectId && !host.directory.get()) throw new FlowError('no-project', MESSAGES.noProject);
    const request = { ...toAttachRequest(chip), text, navigation: 'open' as const, ...(projectId ? { projectId } : {}) };
    const result = await api.startSession(request);
    if (result.sessionId === null) throw new FlowError('start-failed', MESSAGES.startFailed);
    await client.call('PATCH /designs/:slug', { params: { slug }, body: { sessionId: result.sessionId } });
    return result;
  };

  const flows: Flows = {
    resolveSlashCommand: async ({ command, args }) => {
      const kind: DesignKind | null = command === 'design' ? 'canvas' : command === 'artifact' ? 'artifact' : null;
      if (!kind) throw new FlowError('unknown-command', MESSAGES.unknownCommand);
      const ready = host.ready.get();
      try {
        const { chip } = await client.call('POST /chip', {
          body: { kind, brief: args.trim(), projectDirectory: ready?.directory ?? null, sessionId: ready?.session?.id ?? null },
        });
        return toAttachRequest(chip);
      } catch (error) {
        // The host shows a thrown error's message to the user (F15).
        throw new Error(error instanceof Error ? error.message : String(error));
      }
    },

    newDesign: async ({ kind, brief, preset = null, destination }) => {
      const ready = host.ready.get();
      const directory = host.directory.get();
      const text = brief.trim();
      if (destination === 'new-chat') {
        if (!directory) throw new FlowError('no-project', MESSAGES.noProject);
        const { slug, chip } = await client.call('POST /chip', { body: { kind, brief: text, preset, projectDirectory: directory, sessionId: null } });
        const result = await api.startSession({ ...toAttachRequest(chip), text: text || "Let's start this design.", navigation: 'open' });
        if (result.sessionId === null) throw new FlowError('start-failed', MESSAGES.startFailed);
        await client.call('PATCH /designs/:slug', { params: { slug }, body: { sessionId: result.sessionId } });
        return { slug, sessionId: result.sessionId };
      }
      const session = host.session.get();
      const { slug, chip } = await client.call('POST /chip', {
        body: { kind, brief: text, preset, projectDirectory: directory, sessionId: session?.id ?? null },
      });
      await api.attach(toAttachRequest(chip));
      if (text) await api.compose({ text, mode: 'append' });
      if (ready?.surface === 'page') await api.close();
      // The link is made by reconciliation once the chip is on a session (§10.5).
      return { slug, sessionId: session?.id ?? null };
    },

    continueInChat: async (slug) => {
      const { design } = await client.call('GET /designs/:slug', { params: { slug } });
      if (design.sessionId) {
        try {
          await api.openSession(design.sessionId);
          return { outcome: 'opened', sessionId: design.sessionId };
        } catch (error) {
          if (!isHostError(error, 'NO_SESSION')) throw error;
        }
      }
      const { text, chip } = await client.call('POST /designs/:slug/prompt', { params: { slug }, body: { purpose: 'continue' } });
      const result = await startLinkedSession(slug, chip, text, design.projectDirectory);
      // Safe: startLinkedSession throws when the host returned no session id.
      return { outcome: 'new-session', sessionId: result.sessionId as string };
    },

    sendComments: async (slug, commentIds, anchorStates) => {
      const body: PromptBody = { purpose: 'revision' };
      if (commentIds) body.commentIds = commentIds;
      if (anchorStates && Object.keys(anchorStates).length > 0) body.anchorStates = { ...anchorStates };
      const prompt = await client.call('POST /designs/:slug/prompt', { params: { slug }, body });
      if (prompt.commentIds.length === 0) return { outcome: 'nothing', sessionId: null, commentIds: [], omitted: prompt.omitted };
      const { design } = await client.call('GET /designs/:slug', { params: { slug } });
      const version = await latestVersion(slug);
      const done = (outcome: SendCommentsOutcome, sessionId: string | null, marked = true): SendCommentsResult => ({
        outcome,
        sessionId,
        commentIds: prompt.commentIds,
        omitted: prompt.omitted,
        ...(marked ? {} : { markFailed: true as const }),
      });

      // 1. The linked session is the selected one.
      const selected = host.session.get();
      if (design.sessionId && selected?.id === design.sessionId) {
        const outcome = await promptSelected(selected, prompt.text);
        return done(outcome, selected.id, await markSent(slug, prompt.commentIds, version));
      }

      // 2. Linked but not selected: the rail delivers after openSession (which closes the page).
      if (design.sessionId) {
        await client.call('PUT /outbox', {
          body: { sessionId: design.sessionId, slug, text: prompt.text, commentIds: prompt.commentIds, version },
        });
        try {
          await api.openSurface(PANEL_SURFACE_ID);
        } catch {
          // The rail may already be open or unavailable here; openSession still selects the chat.
        }
        try {
          await api.openSession(design.sessionId);
          return done('outbox', design.sessionId);
        } catch (error) {
          if (!isHostError(error, 'NO_SESSION')) throw error;
          // The session is gone: take the outbox back and fall through to a new chat.
          await client.call('DELETE /outbox');
        }
      }

      // 3. No session, or it is gone: a new chat with the revision as its first message.
      const result = await startLinkedSession(slug, prompt.chip, prompt.text, design.projectDirectory);
      if (result.sent !== 'sent') throw new FlowError('send-failed', MESSAGES.sendFailed);
      return done('new-session', result.sessionId, await markSent(slug, prompt.commentIds, version));
    },

    deliverOutbox: async (session = host.session.get()) => {
      if (!session || delivering) return 'none';
      delivering = true;
      try {
        const { outbox } = await client.call('GET /outbox');
        if (!outbox || outbox.sessionId !== session.id || !isFresh(outbox, now())) return 'none';
        // Take it first: whoever deletes it delivers it (exactly once across rail + page frames).
        const taken = (await client.call('DELETE /outbox')).outbox;
        if (!taken) return 'none';
        if (taken.sessionId !== session.id) {
          // Replaced between read and take: put the other session's outbox back untouched.
          const { created: _created, ...rest } = taken;
          await client.call('PUT /outbox', { body: rest });
          return 'none';
        }
        const outcome = await promptSelected(session, taken.text);
        if (!(await markSent(taken.slug, taken.commentIds, taken.version))) await toast('info', MESSAGES.markFailed);
        return outcome === 'sent' ? 'delivered' : 'composed';
      } finally {
        delivering = false;
      }
    },

    reconcile: async (snapshot, designs) => {
      const patches = planReconciliation(snapshot, designs);
      const done: DesignLink[] = [];
      for (const patch of patches) {
        try {
          await client.call('PATCH /designs/:slug', { params: { slug: patch.slug }, body: { sessionId: patch.sessionId } });
          done.push(patch);
        } catch {
          // One design failing to link (deleted meanwhile) must not stop the others.
        }
      }
      return done;
    },

    snapshotTurn: async (sessionId) => {
      const at = now();
      const last = lastTurn.get(sessionId);
      if (last !== undefined && at - last < TURN_SNAPSHOT_DEDUPE_MS) return;
      lastTurn.set(sessionId, at);
      await client.call('POST /versions/turn', { body: { sessionId } });
    },

    openAsArtifact: async (item, options = {}) => {
      // Early answer for the common case; the service's 422 below stays the authority.
      if (extractHtml(item.text) === null) {
        await toast('info', MESSAGES.noHtml);
        return null;
      }
      try {
        const uploadId = await client.upload(item.text);
        const body = { uploadId, sessionId: item.sessionId, sessionTitle: item.sessionTitle, messageId: item.messageId, directory: item.directory };
        return await client.call('POST /artifacts/from-message', { body: options.open ? { ...body, open: true } : body });
      } catch (error) {
        if (isServiceError(error, 'no-html')) {
          await toast('info', MESSAGES.noHtml);
          return null;
        }
        throw error;
      }
    },

    runAction: async (item) => {
      if (!isGuestMessageItem(item) || item.action !== OPEN_AS_ARTIFACT_ACTION) return;
      const created = await flows.openAsArtifact(item, { open: true });
      if (!created) return;
      let opened = true;
      try {
        await api.openSurface(PANEL_SURFACE_ID);
      } catch {
        // No side panel here (or the rail cannot open): the toast says where to find it.
        opened = false;
      }
      await toast('success', opened ? MESSAGES.savedArtifact(created.title) : MESSAGES.savedArtifactClosed(created.title));
    },

    handleItem: async (item) => {
      if (isGuestAttachItem(item)) {
        if (item.providerId !== CHIP_PROVIDER_ID) return null;
        const data = item.data;
        const slug = typeof data === 'object' && data !== null && !Array.isArray(data) ? data.slug : undefined;
        return typeof slug === 'string' && SLUG_PATTERN.test(slug) ? { kind: 'open-design', slug } : null;
      }
      if (isGuestMessageItem(item) && item.action === OPEN_AS_ARTIFACT_ACTION) {
        const created = await flows.openAsArtifact(item);
        return created ? { kind: 'open-design', slug: created.slug } : null;
      }
      return null;
    },

    watchTurns: () => {
      // The host reports `completed` for any idle session it shows (mount, chat switch), so only
      // a `completed` after a `started` seen here ends a real turn.
      const working = new Set<string>();
      return host.onLifecycle((event) => {
        if (event.phase === 'started') {
          working.add(event.sessionId);
          return;
        }
        const ended = working.delete(event.sessionId);
        if (event.phase !== 'completed' || !ended) return;
        flows.snapshotTurn(event.sessionId).catch(() => {
          // Quiet-period auto snapshots (§4.9) cover a turn snapshot that failed.
        });
      });
    },

    watchOutbox: () =>
      host.session.subscribe((session) => {
        if (!session) return;
        flows.deliverOutbox(session).catch(async (error: unknown) => {
          await toast('error', error instanceof Error && error.message ? error.message : MESSAGES.sendFailed);
        });
      }),

    watchSessions: (designs) => {
      let unsubscribe: (() => void) | null = null;
      let generation = 0;
      const subscribe = async (directory: string | null): Promise<void> => {
        generation += 1;
        const mine = generation;
        unsubscribe?.();
        unsubscribe = null;
        const projectId = await projectIdFor(directory);
        if (!projectId || mine !== generation) return;
        const activity = new Map<string, string>();
        const stop = await api.onSessions(projectId, (snapshot) => {
          void flows.reconcile(snapshot, designs());
          const linked = new Set(designs().map((design) => design.sessionId));
          for (const sessionId of finishedTurns(activity, snapshot)) {
            if (!linked.has(sessionId)) continue;
            flows.snapshotTurn(sessionId).catch(() => {
              // Quiet-period auto snapshots (§4.9) cover a turn snapshot that failed.
            });
          }
          if (snapshot.state === 'ready') for (const session of snapshot.sessions) activity.set(session.id, session.activity);
        });
        if (mine !== generation) stop();
        else unsubscribe = stop;
      };
      const unwatch = host.directory.subscribe((directory) => {
        subscribe(directory).catch(() => {
          // No project list (no `sessions` grant yet): links come from explicit flows only.
        });
      });
      return () => {
        generation += 1;
        unwatch();
        unsubscribe?.();
      };
    },

    watchItems: (open, onError) => {
      // Messages are handled once per frame (each run would create another artifact); a chip
      // only when it differs from the last item, since snapshots replay the current item.
      const seenMessages = new Set<string>();
      let lastKey: string | null = null;
      return host.item.subscribe((item) => {
        if (!item) {
          lastKey = null;
          return;
        }
        const key = isGuestMessageItem(item) ? `message:${item.sessionId}:${item.messageId}` : isGuestAttachItem(item) ? `chip:${item.providerId}:${item.id}` : null;
        if (!key || key === lastKey || seenMessages.has(key)) return;
        lastKey = key;
        if (isGuestMessageItem(item)) seenMessages.add(key);
        flows.handleItem(item).then(
          (target) => {
            if (target) open(target);
          },
          (error: unknown) => onError?.(error),
        );
      });
    },

    watchOpenRequests: (onAdded, open) => {
      let stopped = false;
      const take = (): void => {
        client.call('DELETE /open-request').then(
          ({ request }) => {
            if (request && !stopped && SLUG_PATTERN.test(request.slug)) open({ kind: 'open-design', slug: request.slug });
          },
          () => {
            // The design is in the list either way; a lost open request only skips the jump.
          },
        );
      };
      take();
      const unsubscribe = onAdded(take);
      return () => {
        stopped = true;
        unsubscribe();
      };
    },
  };

  return flows;
};

const isFresh = (outbox: Outbox, at: number): boolean => {
  const created = Date.parse(outbox.created);
  return Number.isNaN(created) || at - created < OUTBOX_TTL_MS;
};
