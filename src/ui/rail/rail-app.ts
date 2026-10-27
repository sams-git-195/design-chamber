// The rail panel app (320–480 px): the list (R1), the compact viewer (R2) and settings (R3) as
// views of one stack, plus the New dialog. Chat links ("Open as artifact", a chip click) open
// the viewer here, because an extension cannot open the full-screen page from code.

import { openNewDialog } from '../components/new-dialog.ts';
import { toast, type ActionContext } from '../components/actions.ts';
import { errorText, h } from '../components/dom.ts';
import { openSheet } from '../components/kit.ts';
import { mountSettings, type SettingsHandle } from '../components/settings-view.ts';
import { feed, flows } from '../guest.ts';
import { mountDesignView, type DesignViewHandle } from '../wall/design-view.ts';
import { mountListView } from './list-view.ts';

export const mountRail = (root: HTMLElement): void => {
  const app = h('div', { class: 'dc-app', 'data-surface': 'panel' });
  root.replaceChildren(app);

  let viewer: { slug: string; handle: DesignViewHandle } | null = null;

  const closeViewer = (): void => {
    const slug = viewer?.slug;
    viewer?.handle.dispose();
    viewer = null;
    list.el.hidden = false;
    if (slug) list.focusRow(slug);
  };

  const openViewer = (slug: string): void => {
    if (viewer?.slug === slug) return;
    viewer?.handle.dispose();
    const handle = mountDesignView({ slug, surface: 'panel', actions, onBack: closeViewer });
    viewer = { slug, handle };
    list.el.hidden = true;
    app.append(handle.el);
  };

  const actions: ActionContext = {
    host: app,
    onOpen: openViewer,
    onRemoved: (slug) => {
      if (viewer?.slug === slug) closeViewer();
    },
  };

  const openSettings = (): void => {
    let settings: SettingsHandle | null = null;
    const sheet = openSheet(app, { title: 'Settings', variant: 'full', onClose: () => settings?.dispose() });
    settings = mountSettings(sheet.body);
  };

  const list = mountListView({
    actions,
    onOpen: openViewer,
    onSettings: openSettings,
    onNew: (kind) => openNewDialog(app, { kind, onCreated: openViewer }),
  });
  app.append(list.el);

  // A chip click or "Open as artifact" opens the viewer here.
  flows.watchItems(
    (target) => openViewer(target.slug),
    (error) => toast('error', `Couldn’t open that design. ${errorText(error)}`),
  );
  // "Open as artifact" runs in the background frame and leaves the new artifact for us to open.
  flows.watchOpenRequests(
    (listener) => feed.subscribe((batch) => {
      if (batch.reset || batch.events.some((event) => event.kind === 'added')) listener();
    }),
    (target) => openViewer(target.slug),
  );
};
