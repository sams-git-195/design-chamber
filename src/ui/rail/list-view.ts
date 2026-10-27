// R1 — the rail's designs list: header (New, settings), search, tabs, thumbnail rows with
// badges and a row menu, an empty state, and a notice when an earlier folder still holds designs.

import { mountBanner, mountEmpty, mountSearchField, mountTabs } from '@openchamber/sdk/ui';

import type { DesignSummary } from '../../shared/types.ts';
import { runDesignAction, designMenu, type ActionContext } from '../components/actions.ts';
import { createScope, h } from '../components/dom.ts';
import { icon } from '../components/icons.ts';
import { attachMenu, btn, iconBtn } from '../components/kit.ts';
import { mountThumb, type ThumbHandle } from '../components/thumb.ts';
import { host, store } from '../guest.ts';
import { middlePath, relativeTime, plural } from '../model/format.ts';
import { LIST_TABS, emptyKind, filterDesigns, kindSummary, rowAriaLabel, sortDesigns, tabCounts, type ListTab } from '../model/list-model.ts';
import { designCountLabel } from '../model/settings-model.ts';
import { toast } from '../components/actions.ts';

export type ListViewOptions = {
  actions: ActionContext;
  onNew: (kind: 'canvas' | 'artifact') => void;
  onSettings: () => void;
  onOpen: (slug: string) => void;
};

export type ListViewHandle = { el: HTMLElement; focusRow: (slug: string) => void; dispose: () => void };

const SKELETON_ROWS = 4;

export const mountListView = (options: ListViewOptions): ListViewHandle => {
  const scope = createScope();
  let query = '';
  let tab: ListTab = 'all';
  const thumbs = new Map<string, ThumbHandle>();

  const el = h('div', { class: 'dc-list-view' });

  // header
  const newButton = btn({ label: 'New', variant: 'default', size: 'sm', icon: 'plus', chevron: true, onClick: () => undefined });
  attachMenu(
    newButton.el,
    () => [
      { id: 'canvas', label: 'Canvas…', hint: 'several screens' },
      { id: 'artifact', label: 'Artifact…', hint: 'one HTML page' },
    ],
    (id) => options.onNew(id === 'artifact' ? 'artifact' : 'canvas'),
  );
  const settingsButton = iconBtn({ icon: 'settings', label: 'Settings', onClick: () => options.onSettings() });
  const head = h('header', { class: 'dc-rail-head' }, h('h1', { class: 'dc-rail-title' }, 'Designs'), h('span', { class: 'dc-spacer' }), newButton.el, settingsButton);

  // filters
  const searchHost = h('div', { class: 'dc-search' });
  const search = mountSearchField(searchHost, { value: '', placeholder: 'Search designs', label: 'Search designs', onChange: (value) => {
    query = value;
    search.update({ value });
    paintList();
  } });
  const tabsHost = h('div', { class: 'dc-tabs' });
  const tabsHandle = mountTabs(tabsHost, { items: LIST_TABS.map(({ id, label }) => ({ id, label })), activeId: tab, trackBackground: true, onChange: (id) => {
    tab = LIST_TABS.find((entry) => entry.id === id)?.id ?? 'all';
    tabsHandle.update({ activeId: tab });
    paintList();
  } });
  const filters = h('div', { class: 'dc-rail-filters' }, searchHost, tabsHost);

  const notices = h('div', { class: 'dc-rail-notices' });
  const list = h('ul', { class: 'dc-rows', role: 'list', 'aria-label': 'Designs' });
  const scroller = h('div', { class: 'dc-rail-scroll' }, notices, list);
  el.append(head, filters, scroller);

  const switchBack = async (path: string): Promise<void> => {
    try {
      await store.updateSettings({ root: path });
      await store.refreshDesigns();
    } catch (error) {
      toast('error', `Couldn’t switch back. ${error instanceof Error ? error.message : ''}`);
    }
  };

  const rowFor = (design: DesignSummary): HTMLElement => {
    let thumb = thumbs.get(design.slug);
    if (thumb) thumb.update(design);
    else {
      thumb = mountThumb(design, 'rail');
      thumbs.set(design.slug, thumb);
    }
    const locale = host.snapshot()?.locale ?? 'en';
    const meta = h('span', { class: 'dc-row-meta' }, `${kindSummary(design)} · ${relativeTime(design.updated, Date.now(), locale)}`);
    const flags = h('span', { class: 'dc-row-flags' });
    if (design.pending) flags.append(h('span', { class: 'dc-flag', 'data-tone': 'warning' }, 'Waiting for agent'));
    if (design.openComments > 0) flags.append(h('span', { class: 'dc-flag', title: plural(design.openComments, 'open comment') }, icon('pin', 12), String(design.openComments)));
    if (design.sessionId) flags.append(h('span', { class: 'dc-flag dc-flag-icon', title: 'Linked to a chat', role: 'img', 'aria-label': 'Linked to a chat' }, icon('chat', 12)));
    const main = h('button', { type: 'button', class: 'dc-row-main', 'aria-label': rowAriaLabel(design) }, thumb.el, h('span', { class: 'dc-row-text' }, h('span', { class: 'dc-row-title' }, design.title), meta, flags.childElementCount > 0 ? flags : null));
    main.addEventListener('click', () => options.onOpen(design.slug));
    const more = iconBtn({ icon: 'more', label: `Actions for ${design.title}`, size: 'sm', onClick: () => undefined });
    const ref = { slug: design.slug, title: design.title, kind: design.kind, sessionId: design.sessionId };
    attachMenu(more, () => designMenu({ includeOpen: true }), (id) => runDesignAction(id, ref, options.actions));
    return h('li', { class: 'dc-row', 'data-pending': design.pending ? 'true' : 'false', 'data-slug': design.slug }, main, more);
  };

  const skeleton = (): HTMLElement[] =>
    Array.from({ length: SKELETON_ROWS }, () => h('li', { class: 'dc-row dc-row-skeleton', 'aria-hidden': 'true' }, h('span', { class: 'dc-skel dc-skel-thumb' }), h('span', { class: 'dc-skel-lines' }, h('span', { class: 'dc-skel dc-skel-line' }), h('span', { class: 'dc-skel dc-skel-line dc-skel-short' }))));

  const paintNotices = (): void => {
    notices.replaceChildren();
    const state = store.getState();
    if (state.designs.status === 'error' && state.designs.data) {
      const wrap = h('div', { class: 'dc-banner' });
      mountBanner(wrap, { tone: 'warning', title: 'Couldn’t refresh the list', body: state.designs.error?.message ?? '', action: { label: 'Try again', onClick: () => void store.refreshDesigns() } });
      notices.append(wrap);
    }
    const holders = state.settings.data?.previousRoots.filter((root) => root.exists && root.designCount > 0) ?? [];
    const first = holders[0];
    if (first) {
      const wrap = h('div', { class: 'dc-banner' });
      mountBanner(wrap, { tone: 'info', title: `${designCountLabel(first.designCount)} remain in your earlier folder`, body: middlePath(first.path), action: { label: 'Switch back', onClick: () => void switchBack(first.path) } });
      wrap.title = first.path;
      notices.append(wrap);
    }
  };

  const paintList = (): void => {
    const state = store.getState().designs;
    list.replaceChildren();
    for (const handle of [...thumbs.values()]) handle.el.remove();
    paintNotices();
    if ((state.status === 'idle' || state.status === 'loading') && !state.data) {
      list.append(...skeleton());
      return;
    }
    if (!state.data) {
      const wrap = h('div', { class: 'dc-banner dc-banner-block' });
      mountBanner(wrap, { tone: 'error', title: 'Your designs didn’t load', body: state.error?.message ?? 'The local service didn’t answer. Allow it in Settings → Extensions, then try again.', action: { label: 'Try again', onClick: () => void store.refreshDesigns() } });
      list.append(h('li', { class: 'dc-list-message' }, wrap));
      return;
    }
    const all = state.data.designs;
    const shown = sortDesigns(filterDesigns(all, query, tab), 'updated');
    tabsHandle.update({ items: LIST_TABS.map(({ id, label }) => ({ id, label, count: tabCounts(all, query)[id] })) });
    const kind = emptyKind(all, shown);
    if (kind === 'no-designs') {
      const wrap = h('div');
      mountEmpty(wrap, { title: 'No designs yet', body: 'Type /design in any chat and describe what you want. Your agent writes the files and they show up here.', action: { label: 'New canvas', onClick: () => options.onNew('canvas') } });
      list.append(h('li', { class: 'dc-list-message' }, wrap));
    } else if (kind === 'no-matches') {
      const wrap = h('div');
      mountEmpty(wrap, { title: query.trim() !== '' ? `No designs match “${query.trim()}”` : 'Nothing in this tab yet', body: 'Try another word, or look in All.', action: { label: 'Clear filters', onClick: () => { query = ''; tab = 'all'; search.update({ value: '' }); tabsHandle.update({ activeId: 'all' }); paintList(); } } });
      list.append(h('li', { class: 'dc-list-message' }, wrap));
    } else {
      list.append(...shown.map(rowFor));
    }
    const live = new Set(all.map((design) => design.slug));
    for (const [slug, handle] of thumbs) {
      if (!live.has(slug)) {
        handle.dispose();
        thumbs.delete(slug);
      }
    }
  };

  // Settings and designs can change under us (a folder switch, an agent writing a file).
  let signature = '';
  scope.add(
    store.subscribe(() => {
      const state = store.getState();
      const next = `${state.designs.status}:${JSON.stringify(state.designs.data?.designs ?? null)}:${state.designs.error?.message ?? ''}:${JSON.stringify(state.settings.data?.previousRoots ?? null)}`;
      if (next === signature) return;
      signature = next;
      paintList();
    }),
  );
  const minute = setInterval(paintList, 60_000);
  scope.add(() => clearInterval(minute));

  void store.refreshDesigns();
  void store.loadSettings();
  paintList();

  return {
    el,
    focusRow: (slug) => {
      list.querySelector<HTMLElement>(`[data-slug="${CSS.escape(slug)}"] .dc-row-main`)?.focus();
    },
    dispose: () => {
      scope.dispose();
      for (const handle of thumbs.values()) handle.dispose();
      thumbs.clear();
      search.dispose();
      tabsHandle.dispose();
      el.remove();
    },
  };
};
