// P1 — the page's library: toolbar (search, tabs, sort, New, settings) over a responsive grid
// of design cards with 16:10 thumbnails. Cards update live from change events without losing scroll.

import { mountBadge, mountBanner, mountEmpty, mountSearchField, mountSelect, mountTabs } from '@openchamber/sdk/ui';

import type { DesignSummary } from '../../shared/types.ts';
import { designMenu, runDesignAction, toast, type ActionContext } from '../components/actions.ts';
import { createScope, h } from '../components/dom.ts';
import { icon } from '../components/icons.ts';
import { attachMenu, btn, iconBtn } from '../components/kit.ts';
import { mountThumb, type ThumbHandle } from '../components/thumb.ts';
import { host, store } from '../guest.ts';
import { middlePath, plural, relativeTime } from '../model/format.ts';
import { LIST_SORTS, LIST_TABS, emptyKind, filterDesigns, kindLabel, rowAriaLabel, sortDesigns, tabCounts, type ListSort, type ListTab } from '../model/list-model.ts';
import { designCountLabel } from '../model/settings-model.ts';

export type LibraryOptions = {
  actions: ActionContext;
  onNew: (kind: 'canvas' | 'artifact') => void;
  onSettings: () => void;
  onOpen: (slug: string) => void;
};

export type LibraryHandle = { el: HTMLElement; focusCard: (slug: string) => void; dispose: () => void };

const SKELETON_CARDS = 8;

export const mountLibrary = (options: LibraryOptions): LibraryHandle => {
  const scope = createScope();
  let query = '';
  let tab: ListTab = 'all';
  let sort: ListSort = 'updated';
  const thumbs = new Map<string, ThumbHandle>();
  const el = h('div', { class: 'dc-library' });

  const newButton = btn({ label: 'New', variant: 'default', size: 'default', icon: 'plus', chevron: true, onClick: () => undefined });
  attachMenu(
    newButton.el,
    () => [
      { id: 'canvas', label: 'Canvas…', hint: 'several screens' },
      { id: 'artifact', label: 'Artifact…', hint: 'one HTML page' },
    ],
    (id) => options.onNew(id === 'artifact' ? 'artifact' : 'canvas'),
  );
  const settingsButton = btn({ label: 'Settings', variant: 'ghost', size: 'default', icon: 'settings', onClick: () => options.onSettings() });

  const searchHost = h('div', { class: 'dc-search' });
  const search = mountSearchField(searchHost, { value: '', placeholder: 'Search designs', label: 'Search designs', onChange: (value) => {
    query = value;
    search.update({ value });
    paintGrid();
  } });
  const tabsHost = h('div', { class: 'dc-tabs' });
  const tabsHandle = mountTabs(tabsHost, { items: LIST_TABS.map(({ id, label }) => ({ id, label })), activeId: tab, trackBackground: true, onChange: (id) => {
    tab = LIST_TABS.find((entry) => entry.id === id)?.id ?? 'all';
    tabsHandle.update({ activeId: tab });
    paintGrid();
  } });
  const sortHost = h('div', { class: 'dc-sort', title: 'Sort designs' }, h('span', { class: 'dc-sort-label' }, 'Sort'));
  const sortSelect = mountSelect(sortHost, { value: sort, options: LIST_SORTS.map(({ id, label }) => ({ id, label })), onChange: (id) => {
    sort = LIST_SORTS.find((entry) => entry.id === id)?.id ?? 'updated';
    sortSelect.update({ value: sort });
    paintGrid();
  } });

  const toolbar = h(
    'header',
    { class: 'dc-library-bar' },
    h('h1', { class: 'dc-page-title' }, 'Designs'),
    h('div', { class: 'dc-library-controls' }, searchHost, tabsHost, sortHost),
    h('span', { class: 'dc-spacer' }),
    settingsButton.el,
    newButton.el,
  );
  const notices = h('div', { class: 'dc-library-notices' });
  const grid = h('ul', { class: 'dc-grid', role: 'list', 'aria-label': 'Designs' });
  const scroller = h('div', { class: 'dc-library-scroll' }, notices, grid);
  el.append(toolbar, scroller);

  const switchBack = async (path: string): Promise<void> => {
    try {
      await store.updateSettings({ root: path });
      await store.refreshDesigns();
    } catch (error) {
      toast('error', `Couldn’t switch back. ${error instanceof Error ? error.message : ''}`);
    }
  };

  const card = (design: DesignSummary): HTMLElement => {
    let thumb = thumbs.get(design.slug);
    if (thumb) thumb.update(design);
    else {
      thumb = mountThumb(design, 'card');
      thumbs.set(design.slug, thumb);
    }
    const kindBadge = h('span');
    mountBadge(kindBadge, { label: kindLabel(design.kind), tone: 'neutral' });
    const locale = host.snapshot()?.locale ?? 'en';
    const indicators = h('span', { class: 'dc-card-flags' });
    if (design.openComments > 0) indicators.append(h('span', { class: 'dc-flag', title: plural(design.openComments, 'open comment') }, icon('pin', 12), String(design.openComments)));
    if (design.sessionId) indicators.append(h('span', { class: 'dc-flag dc-flag-icon', title: 'Linked to a chat', role: 'img', 'aria-label': 'Linked to a chat' }, icon('chat', 12)));
    const main = h(
      'button',
      { type: 'button', class: 'dc-card-main', 'aria-label': rowAriaLabel(design) },
      h('span', { class: 'dc-card-thumb' }, thumb.el, design.pending ? h('span', { class: 'dc-card-overlay' }, h('span', { class: 'dc-flag', 'data-tone': 'warning' }, 'Waiting for agent')) : null),
      h('span', { class: 'dc-card-body' }, h('span', { class: 'dc-card-title' }, design.title), h('span', { class: 'dc-card-meta' }, kindBadge, h('span', { class: 'dc-muted' }, relativeTime(design.updated, Date.now(), locale)), indicators)),
    );
    main.addEventListener('click', () => options.onOpen(design.slug));
    const more = iconBtn({ icon: 'more', label: `Actions for ${design.title}`, size: 'sm', onClick: () => undefined });
    more.classList.add('dc-card-more');
    const ref = { slug: design.slug, title: design.title, kind: design.kind, sessionId: design.sessionId };
    attachMenu(more, () => designMenu({ includeOpen: true }), (id) => runDesignAction(id, ref, options.actions));
    return h('li', { class: 'dc-card', 'data-slug': design.slug, 'data-pending': design.pending ? 'true' : 'false' }, main, more);
  };

  const skeletons = (): HTMLElement[] =>
    Array.from({ length: SKELETON_CARDS }, () => h('li', { class: 'dc-card dc-card-skeleton', 'aria-hidden': 'true' }, h('span', { class: 'dc-skel dc-skel-card' }), h('span', { class: 'dc-skel dc-skel-line' }), h('span', { class: 'dc-skel dc-skel-line dc-skel-short' })));

  const message = (...children: Array<Node>): HTMLElement => h('li', { class: 'dc-grid-message' }, ...children);

  const paintNotices = (): void => {
    notices.replaceChildren();
    const state = store.getState();
    if (state.designs.status === 'error' && state.designs.data) {
      const wrap = h('div', { class: 'dc-banner' });
      mountBanner(wrap, { tone: 'warning', title: 'Couldn’t refresh the list', body: state.designs.error?.message ?? '', action: { label: 'Try again', onClick: () => void store.refreshDesigns() } });
      notices.append(wrap);
    }
    const first = state.settings.data?.previousRoots.find((root) => root.exists && root.designCount > 0);
    if (first) {
      const wrap = h('div', { class: 'dc-banner' });
      mountBanner(wrap, { tone: 'info', title: `${designCountLabel(first.designCount)} remain in your earlier folder`, body: middlePath(first.path), action: { label: 'Switch back', onClick: () => void switchBack(first.path) } });
      wrap.title = first.path;
      notices.append(wrap);
    }
  };

  const paintGrid = (): void => {
    const previousScroll = scroller.scrollTop;
    const state = store.getState().designs;
    grid.replaceChildren();
    paintNotices();
    if ((state.status === 'idle' || state.status === 'loading') && !state.data) {
      grid.append(...skeletons());
      return;
    }
    if (!state.data) {
      const wrap = h('div');
      mountBanner(wrap, { tone: 'error', title: 'Your designs didn’t load', body: state.error?.message ?? 'The local service didn’t answer. Allow it in Settings → Extensions, then try again.', action: { label: 'Try again', onClick: () => void store.refreshDesigns() } });
      grid.append(message(wrap));
      return;
    }
    const all = state.data.designs;
    const shown = sortDesigns(filterDesigns(all, query, tab), sort);
    const counts = tabCounts(all, query);
    tabsHandle.update({ items: LIST_TABS.map(({ id, label }) => ({ id, label, count: counts[id] })) });
    const kind = emptyKind(all, shown);
    if (kind === 'no-designs') {
      const wrap = h('div');
      mountEmpty(wrap, { title: 'No designs yet', body: 'Type /design in any chat and describe what you want. Your agent writes the files and they show up here the moment they are saved.', action: { label: 'New canvas', onClick: () => options.onNew('canvas') } });
      grid.append(message(wrap));
    } else if (kind === 'no-matches') {
      const wrap = h('div');
      mountEmpty(wrap, { title: query.trim() !== '' ? `No designs match “${query.trim()}”` : 'Nothing in this tab yet', body: 'Try another word, or look in All.', action: { label: 'Clear filters', onClick: () => {
        query = '';
        tab = 'all';
        search.update({ value: '' });
        tabsHandle.update({ activeId: 'all' });
        paintGrid();
      } } });
      grid.append(message(wrap));
    } else grid.append(...shown.map(card));
    const live = new Set(all.map((design) => design.slug));
    for (const [slug, handle] of thumbs) {
      if (!live.has(slug)) {
        handle.dispose();
        thumbs.delete(slug);
      }
    }
    scroller.scrollTop = previousScroll;
  };

  let signature = '';
  scope.add(
    store.subscribe(() => {
      const state = store.getState();
      const next = `${state.designs.status}:${JSON.stringify(state.designs.data?.designs ?? null)}:${state.designs.error?.message ?? ''}:${JSON.stringify(state.settings.data?.previousRoots ?? null)}`;
      if (next === signature) return;
      signature = next;
      paintGrid();
    }),
  );
  const minute = setInterval(paintGrid, 60_000);
  scope.add(() => clearInterval(minute));

  void store.refreshDesigns();
  void store.loadSettings();
  paintGrid();

  return {
    el,
    focusCard: (slug) => {
      grid.querySelector<HTMLElement>(`[data-slug="${CSS.escape(slug)}"] .dc-card-main`)?.focus();
    },
    dispose: () => {
      scope.dispose();
      for (const handle of thumbs.values()) handle.dispose();
      thumbs.clear();
      search.dispose();
      tabsHandle.dispose();
      sortSelect.dispose();
      el.remove();
    },
  };
};
