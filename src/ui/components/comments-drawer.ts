// Comments (P3, and the rail's comments sheet): every comment of a design grouped by screen,
// filtered by status, with the one action that matters — send the open ones to the linked chat.

import { mountTabs } from '@openchamber/sdk/ui';

import type { Comment } from '../../shared/types.ts';
import type { AnchorState } from '../../shared/types.ts';
import { MESSAGES } from '../../guest/flows.ts';
import { flows, store } from '../guest.ts';
import { COMMENT_FILTERS, countByStatus, groupComments, pinNumbers, sendState, statusLabel, viewportOf, type CommentFilter } from '../model/comments-model.ts';
import { plural } from '../model/format.ts';
import { toast } from './actions.ts';
import { createScope, errorText, h } from './dom.ts';
import { banner, btn, iconBtn, loadingRow } from './kit.ts';

export type CommentsHandle = { el: HTMLElement; refresh: () => void; dispose: () => void };

export type CommentsOptions = {
  slug: string;
  onLocate: (id: string) => void;
  /** Ids the wall found no element for. */
  detached: () => ReadonlySet<string>;
  /** What the artboards' pin trackers know about each anchor, sent with the revision. */
  anchorStates: () => Record<string, AnchorState>;
};

const MENTION = 'Switch to Edit and click anything on the wall to pin a comment to it.';

export const mountComments = (options: CommentsOptions): CommentsHandle => {
  const scope = createScope();
  const el = h('div', { class: 'dc-comments' });
  let filter: CommentFilter = 'open';
  let sending = false;
  let sendError: string | null = null;
  let filterTouched = false;

  const detail = () => {
    const open = store.getState().open;
    return open?.slug === options.slug ? open : null;
  };

  const updateStatus = async (comment: Comment, status: 'open' | 'resolved'): Promise<void> => {
    try {
      await store.updateComment(options.slug, comment.id, { status });
    } catch (error) {
      toast('error', `Couldn’t update that comment. ${errorText(error)}`);
    }
  };

  const send = async (ids: string[]): Promise<void> => {
    sending = true;
    sendError = null;
    paint();
    try {
      const result = await flows.sendComments(options.slug, ids, options.anchorStates());
      await store.refreshOpenDesign();
      const sent = result.commentIds.length;
      // `composed`: the flow already said the agent is busy and the revision waits in the composer.
      if (result.outcome === 'nothing') toast('info', 'There are no open comments to send.');
      else if (result.markFailed) toast('info', MESSAGES.markFailed);
      else if (result.omitted.length > 0) toast('info', `${sent} of ${sent + result.omitted.length} comments sent. Send again for the rest.`);
      else if (result.outcome === 'new-session') toast('success', `Started a new chat with ${plural(sent, 'comment')}.`);
      else if (result.outcome !== 'composed') toast('success', `${plural(sent, 'comment')} sent to the chat.`);
    } catch (error) {
      sendError = `Couldn’t send. ${errorText(error)} Your comments are still here.`;
    } finally {
      sending = false;
      paint();
    }
  };

  const item = (comment: Comment, number: number, detachedHere: boolean, design: { viewports: Parameters<typeof viewportOf>[0] }): HTMLElement => {
    const resolved = comment.status === 'resolved';
    const toggle = iconBtn({
      icon: resolved ? 'restore' : 'check',
      label: resolved ? `Reopen comment ${number}` : `Mark comment ${number} resolved`,
      size: 'sm',
      onClick: (event) => {
        event.stopPropagation();
        void updateStatus(comment, resolved ? 'open' : 'resolved');
      },
    });
    const main = h(
      'button',
      { type: 'button', class: 'dc-comment-main', 'aria-label': `Show comment ${number} on the wall` },
      h('span', { class: 'dc-pin-badge', 'data-status': comment.status, 'aria-hidden': 'true' }, resolved ? '✓' : String(number)),
      h(
        'span',
        { class: 'dc-comment-text' },
        h('span', { class: 'dc-comment-where' }, viewportOf(design.viewports, comment.viewport)),
        h('span', { class: 'dc-comment-body' }, comment.body),
        h('span', { class: 'dc-comment-el' }, h('code', { class: 'dc-chip-code' }, comment.anchor.selector.split(' > ').slice(-1)[0] ?? comment.anchor.selector), comment.anchor.text ? ` “${comment.anchor.text.slice(0, 48)}${comment.anchor.text.length > 48 ? '…' : ''}”` : ''),
        detachedHere ? h('span', { class: 'dc-comment-note' }, 'Element not found in the current file') : null,
      ),
    );
    main.addEventListener('click', () => options.onLocate(comment.id));
    return h('li', { class: 'dc-comment', 'data-detached': detachedHere ? 'true' : 'false' }, main, toggle);
  };

  const paint = (): void => {
    const state = detail();
    const previousScroll = el.querySelector('.dc-comments-list')?.scrollTop ?? 0;
    el.replaceChildren();
    if (!state || state.status === 'idle' || (state.status === 'loading' && !state.data)) {
      el.append(loadingRow('Loading comments…'));
      return;
    }
    if (!state.data) {
      el.append(banner({ tone: 'error', title: 'Comments didn’t load', body: state.error?.message ?? 'The local service didn’t answer.', action: { label: 'Try again', onClick: () => void store.refreshOpenDesign() } }));
      return;
    }
    const { design } = state.data;
    const counts = countByStatus(design.comments);
    if (!filterTouched && counts.open === 0 && design.comments.length > 0) filter = counts.sent > 0 ? 'sent' : 'resolved';
    const numbers = pinNumbers(design.comments);
    const missing = options.detached();

    const tabsHost = h('div', { class: 'dc-comments-tabs' });
    mountTabs(tabsHost, {
      items: COMMENT_FILTERS.map(({ id, label }) => ({ id, label, count: counts[id] })),
      activeId: filter,
      trackBackground: true,
      onChange: (id) => {
        filter = COMMENT_FILTERS.find((entry) => entry.id === id)?.id ?? 'open';
        filterTouched = true;
        paint();
      },
    });

    const shown = design.comments.filter((comment) => comment.status === filter);
    const list = h('div', { class: 'dc-comments-list' });
    if (design.comments.length === 0) {
      list.append(h('div', { class: 'dc-empty' }, h('p', { class: 'dc-empty-title' }, 'No comments yet'), h('p', { class: 'dc-empty-body' }, MENTION)));
    } else if (shown.length === 0) {
      list.append(h('div', { class: 'dc-empty' }, h('p', { class: 'dc-empty-title' }, `No ${statusLabel(filter).toLowerCase()} comments`), h('p', { class: 'dc-empty-body' }, filter === 'open' ? 'Everything has been sent or resolved.' : 'Nothing here yet.')));
    } else {
      const lost = shown.filter((comment) => missing.has(comment.id));
      const placed = shown.filter((comment) => !missing.has(comment.id));
      for (const group of groupComments(placed, design.screens, design.title)) {
        list.append(
          h('section', { class: 'dc-comment-group' }, h('h3', { class: 'dc-group-title' }, group.title, h('span', { class: 'dc-muted' }, String(group.comments.length))), h('ul', { class: 'dc-comment-items' }, ...group.comments.map((comment) => item(comment, numbers.get(comment.id) ?? 0, false, design)))),
        );
      }
      if (lost.length > 0) {
        list.append(
          h('section', { class: 'dc-comment-group' }, h('h3', { class: 'dc-group-title' }, 'Detached', h('span', { class: 'dc-muted' }, String(lost.length))), h('p', { class: 'dc-group-note' }, 'These elements are gone from the current files. They are still sent, with their old selector.'), h('ul', { class: 'dc-comment-items' }, ...lost.map((comment) => item(comment, numbers.get(comment.id) ?? 0, true, design)))),
        );
      }
    }

    const state2 = sendState(design.comments, design.sessionId !== null);
    const submit = btn({
      label: state2.label,
      variant: 'default',
      size: 'default',
      loading: sending,
      disabled: !state2.enabled,
      onClick: () =>
        void send(
          design.comments.filter((comment) => comment.status === 'open').map((comment) => comment.id),
        ),
    });
    submit.el.classList.add('dc-block');
    const foot = h('div', { class: 'dc-comments-foot' }, sendError ? h('p', { class: 'dc-form-error', role: 'alert' }, sendError) : null, submit.el, state2.reason ? h('p', { class: 'dc-foot-note' }, state2.reason) : null);

    el.append(tabsHost, list, foot);
    list.scrollTop = previousScroll;
  };

  scope.add(store.subscribe(paint));
  paint();
  return {
    el,
    refresh: paint,
    dispose: () => {
      scope.dispose();
      el.remove();
    },
  };
};
