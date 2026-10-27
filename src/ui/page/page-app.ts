// The full-screen page app: the library (P1) and one open design (canvas wall P2 / artifact
// viewer P6) as views of one stack. Settings (P5) opens as a side sheet over either.

import { openNewDialog } from '../components/new-dialog.ts';
import { toast, type ActionContext } from '../components/actions.ts';
import { errorText, h } from '../components/dom.ts';
import { openSheet } from '../components/kit.ts';
import { mountSettings, type SettingsHandle } from '../components/settings-view.ts';
import { flows } from '../guest.ts';
import { mountDesignView, type DesignViewHandle } from '../wall/design-view.ts';
import { mountLibrary } from './library-view.ts';

export const mountPage = (root: HTMLElement): void => {
  const app = h('div', { class: 'dc-app', 'data-surface': 'page' });
  root.replaceChildren(app);

  let open: { slug: string; handle: DesignViewHandle } | null = null;

  const closeDesign = (): void => {
    const slug = open?.slug;
    open?.handle.dispose();
    open = null;
    library.el.hidden = false;
    if (slug) library.focusCard(slug);
  };

  const openDesign = (slug: string): void => {
    if (open?.slug === slug) return;
    open?.handle.dispose();
    const handle = mountDesignView({ slug, surface: 'page', actions, onBack: closeDesign });
    open = { slug, handle };
    library.el.hidden = true;
    app.append(handle.el);
  };

  const actions: ActionContext = {
    host: app,
    onOpen: openDesign,
    onRemoved: (slug) => {
      if (open?.slug === slug) closeDesign();
    },
  };

  const openSettings = (): void => {
    let settings: SettingsHandle | null = null;
    const sheet = openSheet(app, { title: 'Settings', variant: 'side', onClose: () => settings?.dispose() });
    settings = mountSettings(sheet.body);
  };

  const library = mountLibrary({
    actions,
    onOpen: openDesign,
    onSettings: openSettings,
    onNew: (kind) => openNewDialog(app, { kind, onCreated: openDesign }),
  });
  app.append(library.el);

  flows.watchItems(
    (target) => openDesign(target.slug),
    (error) => toast('error', `Couldn’t open that design. ${errorText(error)}`),
  );
};
