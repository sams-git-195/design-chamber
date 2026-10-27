// The two small cards the wall floats next to an element: the composer (new comment) and the
// thread (edit, resolve, delete an existing one). Pure DOM; the wall places them and owns data.

import { mountBadge } from '@openchamber/sdk/ui';

import { COMMENT_BODY_MAX } from '../../shared/limits.ts';
import type { Comment } from '../../shared/types.ts';
import { btn, iconBtn } from '../components/kit.ts';
import { errorText, h } from '../components/dom.ts';
import { statusLabel } from '../model/comments-model.ts';

const isMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.platform);
const submitKey = (): string => (isMac() ? '⌘↵' : 'Ctrl+↵');

const validateBody = (body: string): string | null => {
  if (body.trim() === '') return 'Write what should change, then add the comment.';
  if (body.length > COMMENT_BODY_MAX) return `Keep a comment under ${COMMENT_BODY_MAX} characters.`;
  return null;
};

export type CardHandle = { el: HTMLElement; focus: () => void };

export type ComposerOptions = {
  tag: string;
  snippet: string;
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
};

const textarea = (label: string, value: string, placeholder: string): HTMLTextAreaElement => {
  const area = h('textarea', { class: 'oc-sdk oc-sdk-input dc-textarea', rows: 3, 'aria-label': label, placeholder });
  area.value = value;
  return area;
};

export const createComposer = (options: ComposerOptions): CardHandle => {
  const area = textarea('Comment', '', 'What should change here?');
  const failure = h('p', { class: 'dc-form-error', role: 'alert', hidden: true });
  const cancel = btn({ label: 'Cancel', variant: 'ghost', size: 'sm', onClick: () => options.onCancel() });
  const submit = btn({
    label: 'Add comment',
    variant: 'default',
    size: 'sm',
    onClick: () => void send(),
  });

  const send = async (): Promise<void> => {
    const problem = validateBody(area.value);
    failure.hidden = problem === null;
    if (problem !== null) {
      failure.textContent = problem;
      area.focus();
      return;
    }
    submit.set({ loading: true });
    cancel.set({ disabled: true });
    area.disabled = true;
    try {
      await options.onSubmit(area.value.trim());
    } catch (error) {
      failure.textContent = errorText(error);
      failure.hidden = false;
      submit.set({ loading: false });
      cancel.set({ disabled: false });
      area.disabled = false;
      area.focus();
    }
  };

  area.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      options.onCancel();
    }
  });

  const el = h(
    'div',
    { class: 'dc-pop dc-composer', role: 'dialog', 'aria-label': 'New comment' },
    h('div', { class: 'dc-pop-head' }, h('span', { class: 'dc-pop-title' }, 'Comment on'), h('code', { class: 'dc-chip-code' }, `<${options.tag}>`)),
    options.snippet ? h('p', { class: 'dc-pop-snippet' }, `“${options.snippet}”`) : null,
    area,
    failure,
    h('div', { class: 'dc-pop-foot' }, h('span', { class: 'dc-pop-hint' }, `${submitKey()} to add`), h('span', { class: 'dc-pop-actions' }, cancel.el, submit.el)),
  );
  return { el, focus: () => area.focus() };
};

export type ThreadOptions = {
  comment: Comment;
  number: number;
  where: string;
  /** `exact` = matched by selector, `moved` = matched by text, `detached` = not found. */
  anchorState: 'exact' | 'moved' | 'detached' | 'unknown';
  readOnly: boolean;
  onSave: (body: string) => Promise<void>;
  onStatus: (status: 'open' | 'resolved') => Promise<void>;
  onDelete: () => Promise<void>;
  onClose: () => void;
};

const ANCHOR_NOTE: Record<ThreadOptions['anchorState'], string | null> = {
  exact: null,
  unknown: null,
  moved: 'The element moved; the pin follows it by its text.',
  detached: 'This element is not in the current file. The pin stays where it was.',
};

export const createThread = (options: ThreadOptions): CardHandle => {
  const { comment } = options;
  const area = textarea('Comment text', comment.body, '');
  area.disabled = options.readOnly;
  const failure = h('p', { class: 'dc-form-error', role: 'alert', hidden: true });
  const badgeHost = h('span');
  mountBadge(badgeHost, { label: statusLabel(comment.status), tone: comment.status === 'open' ? 'primary' : comment.status === 'sent' ? 'info' : 'neutral' });

  const guard = async (button: ReturnType<typeof btn>, action: () => Promise<void>): Promise<void> => {
    button.set({ loading: true });
    failure.hidden = true;
    try {
      await action();
    } catch (error) {
      failure.textContent = errorText(error);
      failure.hidden = false;
      button.set({ loading: false });
    }
  };

  const save = btn({
    label: 'Save',
    variant: 'default',
    size: 'sm',
    disabled: true,
    onClick: () => {
      const problem = validateBody(area.value);
      if (problem !== null) {
        failure.textContent = problem;
        failure.hidden = false;
        return;
      }
      void guard(save, () => options.onSave(area.value.trim()));
    },
  });
  area.addEventListener('input', () => save.set({ disabled: area.value.trim() === comment.body.trim() }));
  area.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      options.onClose();
    }
  });

  const resolved = comment.status === 'resolved';
  const toggle = btn({
    label: resolved ? 'Reopen' : 'Resolve',
    variant: 'outline',
    size: 'sm',
    icon: resolved ? 'restore' : 'check',
    onClick: () => void guard(toggle, () => options.onStatus(resolved ? 'open' : 'resolved')),
  });

  let armed = false;
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  const remove = btn({
    label: 'Delete',
    variant: 'ghost',
    size: 'sm',
    icon: 'trash',
    onClick: () => {
      if (!armed) {
        armed = true;
        remove.set({ label: 'Delete comment?' });
        remove.el.dataset.variant = 'destructive';
        armTimer = setTimeout(() => {
          armed = false;
          remove.set({ label: 'Delete' });
          remove.el.dataset.variant = 'ghost';
        }, 4000);
        return;
      }
      clearTimeout(armTimer);
      void guard(remove, () => options.onDelete());
    },
  });

  const close = iconBtn({ icon: 'close', label: 'Close comment', size: 'sm', onClick: () => options.onClose() });

  const note = ANCHOR_NOTE[options.anchorState];
  const el = h(
    'div',
    { class: 'dc-pop dc-thread', role: 'dialog', 'aria-label': `Comment ${options.number}` },
    h('div', { class: 'dc-pop-head' }, h('span', { class: 'dc-pin-badge', 'aria-hidden': 'true' }, String(options.number)), badgeHost, h('span', { class: 'dc-pop-where' }, options.where), close),
    h('p', { class: 'dc-pop-snippet' }, h('code', { class: 'dc-chip-code' }, comment.anchor.selector.split(' > ').slice(-1)[0] ?? comment.anchor.selector)),
    note ? h('p', { class: 'dc-pop-note' }, note) : null,
    area,
    failure,
    options.readOnly ? null : h('div', { class: 'dc-pop-foot' }, remove.el, h('span', { class: 'dc-pop-actions' }, toggle.el, save.el)),
  );
  return { el, focus: () => area.focus() };
};
