// Versions (P4): every saved state of a design, newest first. View a version on the wall,
// compare it with the current design, or restore it (the current state is saved first).

import { mountBadge } from '@openchamber/sdk/ui';

import type { VersionDiffResponse } from '../../shared/api.ts';
import { host, store } from '../guest.ts';
import { relativeTime } from '../model/format.ts';
import { changeLabel, restoreConfirmBody, versionRows, type VersionRow } from '../model/versions-model.ts';
import { toast } from './actions.ts';
import { createScope, errorText, h } from './dom.ts';
import { banner, btn, confirmDialog, loadingRow } from './kit.ts';

export type VersionsHandle = { el: HTMLElement; refresh: () => void; dispose: () => void };

export type VersionsOptions = {
  slug: string;
  /** Element that dialogs mount into. */
  dialogHost: HTMLElement;
  /** The version the wall shows, if any, and whether it is split against the current design. */
  viewing: () => { id: string; compare: boolean } | null;
  onView: (id: string) => void;
  onCompare: (id: string) => void;
  onBackToCurrent: () => void;
  onRestored: () => void;
};

/** The restore confirmation, shared by the versions drawer and the "viewing a version" bar. */
export const confirmRestoreVersion = (dialogHost: HTMLElement, slug: string, version: { id: string; n: number }, onRestored: () => void): void => {
  confirmDialog(dialogHost, {
    title: `Restore v${version.n}?`,
    body: h('p', null, restoreConfirmBody(version.n)),
    confirmLabel: `Restore v${version.n}`,
    onConfirm: async () => {
      try {
        await store.restoreVersion(slug, version.id);
      } catch (error) {
        throw new Error(`Couldn’t restore. ${errorText(error)} Nothing was changed.`);
      }
      await store.refreshOpenDesign();
      onRestored();
      toast('success', `Restored v${version.n}. The previous state is saved as a version.`);
    },
  });
};

export const mountVersions = (options: VersionsOptions): VersionsHandle => {
  const scope = createScope();
  const el = h('div', { class: 'dc-versions' });
  let snapshotBusy = false;
  let diff: { id: string; state: 'loading' | 'ready' | 'error'; files: VersionDiffResponse['files']; error: string | null } | null = null;
  let diffToken = 0;

  const loadDiff = async (id: string): Promise<void> => {
    diffToken += 1;
    const mine = diffToken;
    diff = { id, state: 'loading', files: [], error: null };
    paint();
    try {
      const answer = await store.diffVersion(options.slug, id, 'current');
      if (mine === diffToken) diff = { id, state: 'ready', files: answer.files, error: null };
    } catch (error) {
      if (mine === diffToken) diff = { id, state: 'error', files: [], error: errorText(error) };
    }
    paint();
  };

  const snapshot = async (): Promise<void> => {
    snapshotBusy = true;
    paint();
    try {
      const created = await store.snapshotVersion(options.slug);
      toast('info', created ? `Saved as v${created.n}.` : 'Nothing has changed since the last version.');
    } catch (error) {
      toast('error', `Couldn’t save a version. ${errorText(error)}`);
    } finally {
      snapshotBusy = false;
      paint();
    }
  };

  const restore = (row: VersionRow): void => confirmRestoreVersion(options.dialogHost, options.slug, row, options.onRestored);

  const rowEl = (row: VersionRow, viewing: { id: string; compare: boolean } | null): HTMLElement => {
    const active = viewing?.id === row.id;
    const badge = h('span');
    if (row.current) mountBadge(badge, { label: 'Current', tone: 'success' });
    const actions = h(
      'div',
      { class: 'dc-version-actions' },
      btn({ label: active && !viewing?.compare ? 'Viewing' : 'View', variant: 'outline', size: 'xs', pressed: active && !viewing?.compare, onClick: () => { options.onView(row.id); void loadDiff(row.id); } }).el,
      btn({ label: active && viewing?.compare ? 'Comparing' : 'Compare', variant: 'outline', size: 'xs', icon: 'compare', pressed: active && viewing?.compare, onClick: () => { options.onCompare(row.id); void loadDiff(row.id); } }).el,
      row.current ? null : btn({ label: 'Restore', variant: 'ghost', size: 'xs', onClick: () => restore(row) }).el,
    );
    const changed =
      active && diff && diff.id === row.id
        ? diff.state === 'loading'
          ? loadingRow('Comparing files…')
          : diff.state === 'error'
            ? h('p', { class: 'dc-form-error' }, `Couldn’t compare. ${diff.error ?? ''}`)
            : h(
                'ul',
                { class: 'dc-diff', 'aria-label': `Files changed since v${row.n}` },
                ...(diff.files.length === 0 ? [h('li', { class: 'dc-muted' }, 'Identical to the current design.')] : diff.files.map((file) => h('li', null, h('span', { class: 'dc-diff-kind', 'data-change': file.change }, changeLabel(file.change)), h('code', { class: 'dc-path' }, file.path)))),
              )
        : null;
    return h(
      'li',
      { class: 'dc-version', 'data-active': active ? 'true' : 'false' },
      h('div', { class: 'dc-version-head' }, h('span', { class: 'dc-version-n' }, row.title), badge, h('span', { class: 'dc-muted dc-version-when' }, relativeTime(row.created, Date.now(), host.snapshot()?.locale ?? 'en'))),
      h('p', { class: 'dc-version-reason' }, row.label ?? row.reason, h('span', { class: 'dc-muted' }, ` · ${row.fileCount} files`)),
      actions,
      changed,
    );
  };

  const paint = (): void => {
    const versions = store.getState().versions;
    const state = versions?.slug === options.slug ? versions : null;
    el.replaceChildren();
    if (!state || state.status === 'idle' || (state.status === 'loading' && !state.data)) {
      el.append(loadingRow('Loading versions…'));
      return;
    }
    if (!state.data) {
      el.append(banner({ tone: 'error', title: 'Versions didn’t load', body: state.error?.message ?? 'The local service didn’t answer.', action: { label: 'Try again', onClick: () => void store.loadVersions(options.slug) } }));
      return;
    }
    const { dirty } = state.data;
    const rows = versionRows(state.data.versions, dirty);
    const viewing = options.viewing();
    const save = btn({ label: 'Save a version now', variant: dirty ? 'default' : 'outline', icon: 'history', loading: snapshotBusy, onClick: () => void snapshot() });
    const dirtyRow = dirty
      ? h('li', { class: 'dc-version dc-version-dirty' }, h('div', { class: 'dc-version-head' }, h('span', { class: 'dc-version-n' }, 'Unsaved changes'), h('span', { class: 'dc-muted' }, 'Now')), h('p', { class: 'dc-version-reason' }, 'The files changed since the last version. Versions are also saved after each agent turn.'))
      : null;
    const back = viewing ? btn({ label: 'Back to current', variant: 'outline', icon: 'back', onClick: () => options.onBackToCurrent() }) : null;
    const list = rows.length === 0 && !dirty
      ? h('div', { class: 'dc-empty' }, h('p', { class: 'dc-empty-title' }, 'No versions yet'), h('p', { class: 'dc-empty-body' }, 'A version is saved after each agent turn. You can also save one now.'))
      : h('ul', { class: 'dc-version-list' }, dirtyRow, ...rows.map((row) => rowEl(row, viewing)));
    el.append(h('div', { class: 'dc-versions-bar' }, back?.el ?? null, save.el), list);
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
