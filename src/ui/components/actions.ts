// Design-level actions shared by the rail and the page: the menu every design shows, and the
// handlers behind it. Each one reports its outcome as a toast; failures say what happened.

import { mountTextField } from '@openchamber/sdk/ui';

import { HOST_CLIPBOARD_MAX } from '../../shared/limits.ts';
import type { ExportFormat } from '../../shared/types.ts';
import { client, flows, host, store } from '../guest.ts';
import { errorText, h } from './dom.ts';
import { btn, confirmDialog, openSheet, type MenuEntry } from './kit.ts';

export type DesignRef = { slug: string; title: string; kind: 'canvas' | 'artifact'; sessionId: string | null };

export type ActionContext = {
  /** Element that sheets and dialogs mount into. */
  host: HTMLElement;
  /** Called after an action that changes which designs exist or which one is open. */
  onRemoved: (slug: string) => void;
  onOpen: (slug: string) => void;
};

/** Menu shared by list rows, library cards and the viewer's overflow. `open` is hidden where it would be a no-op. */
export const designMenu = (options: { includeOpen: boolean }): MenuEntry[] => [
  ...(options.includeOpen ? ([{ id: 'open', label: 'Open' }] satisfies MenuEntry[]) : []),
  { id: 'continue', label: 'Continue in chat' },
  { id: 'reveal', label: 'Reveal in folder' },
  { id: 'rename', label: 'Rename' },
  { separator: true },
  { id: 'delete', label: 'Delete…', destructive: true },
];

export const toast = (kind: 'info' | 'success' | 'error', message: string, copy?: string): void => {
  void host.toast(copy ? { kind, message, copy: { text: copy }, dismiss: true } : { kind, message, dismiss: kind === 'error' });
};

export const continueInChat = async (slug: string): Promise<void> => {
  try {
    await flows.continueInChat(slug);
  } catch (error) {
    toast('error', `Couldn’t open the chat. ${errorText(error)}`);
  }
};

export const reveal = async (path: string): Promise<void> => {
  try {
    await store.reveal(path);
  } catch (error) {
    toast('error', `Couldn’t open the folder. ${errorText(error)}`);
  }
};

/** Absolute folder of a design, read from the detail answer. */
export const folderOf = async (slug: string): Promise<string> => (await client.call('GET /designs/:slug', { params: { slug } })).path;

export const revealDesign = async (slug: string): Promise<void> => {
  try {
    await reveal(await folderOf(slug));
  } catch (error) {
    toast('error', `Couldn’t find that folder. ${errorText(error)}`);
  }
};

export const copyPath = async (slug: string): Promise<void> => {
  try {
    const path = await folderOf(slug);
    if (await host.writeClipboard(path)) toast('success', 'Folder path copied.');
    else toast('error', 'Couldn’t reach the clipboard. The path is in the notification — copy it from there.', path);
  } catch (error) {
    toast('error', `Couldn’t read the folder path. ${errorText(error)}`);
  }
};

/** Copy HTML only up to the host clipboard limit; the caller shows the other choice when it is too big. */
export const copyHtml = async (slug: string, screen?: string): Promise<void> => {
  try {
    const source = await store.loadSource(slug, screen ?? null);
    if (source.text.length > HOST_CLIPBOARD_MAX) {
      toast('info', 'This page is too large to copy as text. Use Copy path, or Export HTML.');
      return;
    }
    if (await host.writeClipboard(source.text)) toast('success', 'HTML copied.');
    else toast('error', 'Couldn’t reach the clipboard. Try Export HTML instead.');
  } catch (error) {
    toast('error', `Couldn’t read the HTML. ${errorText(error)}`);
  }
};

export type ExportResult = { path: string; format: ExportFormat };

/** Writes the export through the service; the file lands in Downloads and the caller offers "Show in folder". */
export const exportDesign = async (slug: string, format: ExportFormat, screen?: string): Promise<ExportResult | null> => {
  try {
    const result = await store.exportDesign(slug, screen ? { format, screen } : { format });
    toast('success', `Saved to ${result.path}`, result.path);
    return { path: result.path, format };
  } catch (error) {
    toast('error', `Couldn’t export. ${errorText(error)}`);
    return null;
  }
};

export const renameDesign = async (slug: string, title: string): Promise<void> => {
  const next = title.trim();
  if (next === '') throw new Error('A design needs a name.');
  if (next.length > 120) throw new Error('Keep the name under 120 characters.');
  await store.renameDesign(slug, next);
};

/** "Moves to .trash" confirmation; the only irreversible-feeling action, so the only confirm in the list. */
export const confirmDelete = (context: ActionContext, design: DesignRef): void => {
  confirmDialog(context.host, {
    title: 'Delete this design?',
    body: h('p', null, `“${design.title}” moves to the .trash folder inside your Designs folder. Nothing is erased, and you can move it back by hand.`),
    confirmLabel: 'Move to trash',
    destructive: true,
    onConfirm: async () => {
      try {
        await store.deleteDesign(design.slug);
      } catch (error) {
        throw new Error(`Couldn’t move it to the trash. ${errorText(error)}`);
      }
      context.onRemoved(design.slug);
      toast('success', `“${design.title}” moved to the trash.`);
    },
  });
};

/** Rename in a small dialog: validates inline, keeps what was typed when the save fails. */
export const renameDialog = (hostEl: HTMLElement, design: DesignRef): void => {
  const sheet = openSheet(hostEl, { title: 'Rename design', variant: 'dialog' });
  let value = design.title;
  const field = mountTextField(sheet.body, { label: 'Name', value, onChange: (next) => void (value = next), helper: 'Shown in the list and on the wall. The folder name stays the same.' });
  const submit = btn({ label: 'Save name', variant: 'default', onClick: () => void save() });
  const cancel = btn({ label: 'Cancel', variant: 'ghost', onClick: () => sheet.close() });
  const save = async (): Promise<void> => {
    submit.set({ loading: true });
    cancel.set({ disabled: true });
    try {
      await renameDesign(design.slug, value);
      sheet.close();
    } catch (error) {
      field.update({ error: errorText(error) });
      submit.set({ loading: false });
      cancel.set({ disabled: false });
    }
  };
  sheet.body.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      void save();
    }
  });
  sheet.foot.append(cancel.el, submit.el);
  queueMicrotask(() => sheet.body.querySelector('input')?.select());
};

export const runDesignAction = (id: string, design: DesignRef, context: ActionContext): void => {
  switch (id) {
    case 'open':
      context.onOpen(design.slug);
      return;
    case 'continue':
      void continueInChat(design.slug);
      return;
    case 'reveal':
      void revealDesign(design.slug);
      return;
    case 'rename':
      renameDialog(context.host, design);
      return;
    case 'delete':
      confirmDelete(context, design);
      return;
  }
};
