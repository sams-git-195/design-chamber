// One open design: the canvas wall (P2), the artifact viewer (P6) and the compact rail viewer
// (R2) are the same view with a different toolbar. It owns the toolbar, the wall, the comments
// and versions drawers, and the notices (remote files, saved export, viewing an old version).

import { mountSelect, mountTabs } from '@openchamber/sdk/ui';

import type { DesignDetailResponse } from '../../shared/api.ts';
import { HOST_CLIPBOARD_MAX } from '../../shared/limits.ts';
import type { Viewport } from '../../shared/types.ts';
import { confirmDelete, continueInChat, copyHtml, copyPath, exportDesign, renameDesign, renameDialog, reveal, revealDesign, toast, type ActionContext } from '../components/actions.ts';
import { mountComments, type CommentsHandle } from '../components/comments-drawer.ts';
import { createScope, debounce, errorText, h, replace } from '../components/dom.ts';
import { attachMenu, banner, btn, confirmDialog, iconBtn, loadingRow, openMenu, openSheet, type MenuEntry, type SheetHandle } from '../components/kit.ts';
import { confirmRestoreVersion, mountVersions, type VersionsHandle } from '../components/versions-drawer.ts';
import type { Camera } from '../../guest/camera.ts';
import { renderSourceKey } from '../../guest/store.ts';
import { askSelfContained, host, isServiceError, store } from '../guest.ts';
import { viewportLabel, viewportSize, zoomPercent } from '../model/format.ts';
import { viewingBanner } from '../model/versions-model.ts';
import { createWall, type WallHandle } from './wall.ts';

export type DesignViewOptions = {
  slug: string;
  surface: 'panel' | 'page';
  actions: ActionContext;
  onBack: () => void;
};

export type DesignViewHandle = { el: HTMLElement; dispose: () => void };

type Prefs = { hidden: string[]; camera: Camera | null };
type Drawer = { kind: 'comments' | 'versions'; sheet: SheetHandle; handle: CommentsHandle | VersionsHandle };

const FILL = 'fill';
const FULL_SCREEN_HINT = 'Full screen: sidebar → Extension pages → Design Chamber';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readPrefs = (raw: unknown): Prefs => {
  if (!isRecord(raw)) return { hidden: [], camera: null };
  const hidden = Array.isArray(raw.hidden) ? raw.hidden.filter((entry): entry is string => typeof entry === 'string') : [];
  const camera = isRecord(raw.camera) && typeof raw.camera.x === 'number' && typeof raw.camera.y === 'number' && typeof raw.camera.scale === 'number' ? { x: raw.camera.x, y: raw.camera.y, scale: raw.camera.scale } : null;
  return { hidden, camera };
};

export const mountDesignView = (options: DesignViewOptions): DesignViewHandle => {
  const { slug } = options;
  const compact = options.surface === 'panel';
  const scope = createScope();
  const el = h('div', { class: 'dc-design', 'data-surface': options.surface });
  let disposed = false;
  let built: Built | null = null;
  let building = false;

  type Built = { apply: (data: DesignDetailResponse) => void; dispose: () => void };

  const stateOf = () => {
    const open = store.getState().open;
    return open?.slug === slug ? open : null;
  };

  const backButton = (label: string): HTMLElement => btn({ label, variant: 'ghost', icon: 'back', onClick: options.onBack }).el;

  const showMessage = (...children: Array<Node | null>): void => {
    el.replaceChildren(h('div', { class: 'dc-design-state' }, h('div', { class: 'dc-state-bar' }, backButton(compact ? 'Designs' : 'Library')), h('div', { class: 'dc-state-body' }, ...children)));
  };

  const build = async (first: DesignDetailResponse): Promise<void> => {
    building = true;
    const prefs = readPrefs(await host.storage.get(`view:${slug}`));
    building = false;
    if (disposed) return;
    const bscope = createScope();
    let data = first;
    const design = (): DesignDetailResponse['design'] => data.design;
    const artifact = first.design.kind === 'artifact';

    let mode: 'edit' | 'play' = artifact ? 'play' : 'edit';
    let hidden = new Set(prefs.hidden.filter((id) => first.design.viewports.some((viewport) => viewport.id === id)));
    if (hidden.size >= first.design.viewports.length) hidden = new Set();
    let artifactViewport: string = first.design.viewports[0]?.id ?? FILL;
    let showPins = false;
    let viewing: { id: string; compare: boolean } | null = null;
    let drawer: Drawer | null = null;
    let htmlChars: number | null = null;
    let exported: { path: string; timer: ReturnType<typeof setTimeout> } | null = null;

    const savePrefs = debounce((camera: Camera | null) => {
      void host.storage.set(`view:${slug}`, { hidden: [...hidden], camera });
    }, 500);

    const zoomLabel = btn({ label: '100%', variant: 'ghost', size: 'xs', title: 'Reset zoom to 100%', onClick: () => wall.zoomReset() });
    zoomLabel.el.classList.add('dc-zoom-label');

    // ---------------------------------------------------------------- wall
    const stage = h('div', { class: 'dc-stage' });
    // Set once the drawers exist; on a narrow page the dock is laid over the wall (styles.css).
    let dockEl: HTMLElement | null = null;
    const wall: WallHandle = createWall(
      {
        slug,
        compact,
        coveredRight: () => (dockEl && !dockEl.hidden && getComputedStyle(dockEl).position === 'absolute' ? dockEl.offsetWidth : 0),
        initialCamera: prefs.camera,
        onScale: (next) => zoomLabel.set({ label: zoomPercent(next) }),
        onCameraSettled: (camera) => savePrefs(camera),
        createComment: async (body) => {
          await store.addComment(slug, body);
        },
        updateComment: async (id, patch) => {
          await store.updateComment(slug, id, patch);
        },
        deleteComment: async (id) => {
          await store.deleteComment(slug, id);
        },
        onExternal: (url) =>
          confirmDialog(options.actions.host, {
            title: 'Open this link in your browser?',
            body: h('p', null, h('code', { class: 'dc-path' }, url)),
            confirmLabel: 'Open in browser',
            onConfirm: async () => {
              await host.openUrl(url);
            },
          }),
        onNotice: (message) => toast('info', message),
        onStatus: () => {
          paintNotices();
          if (drawer?.kind === 'comments') (drawer.handle as CommentsHandle).refresh();
        },
      },
      first,
    );
    stage.append(wall.el);
    wall.setMode(mode);
    wall.setShowPins(showPins);
    wall.setHiddenViewports(artifact ? first.design.viewports.filter((viewport) => viewport.id !== artifactViewport).map((viewport) => viewport.id) : [...hidden]);

    // ---------------------------------------------------------------- toolbar controls
    const zoomOut = iconBtn({ icon: 'minus', label: 'Zoom out', size: 'sm', onClick: () => wall.zoomStep(1 / 1.25) });
    const zoomIn = iconBtn({ icon: 'plus', label: 'Zoom in', size: 'sm', onClick: () => wall.zoomStep(1.25) });
    const fit = btn({ label: 'Fit', variant: 'ghost', size: 'xs', icon: 'fit', title: 'Fit everything on screen (Shift+1)', onClick: () => wall.fit() });
    const zoomGroup = h('div', { class: 'dc-group', role: 'group', 'aria-label': 'Zoom' }, zoomOut, zoomLabel.el, zoomIn, fit.el);

    const modeHost = h('div', { class: 'dc-mode' });
    const modeTabs = mountTabs(modeHost, {
      items: [
        { id: 'edit', label: 'Edit' },
        { id: 'play', label: 'Play' },
      ],
      activeId: mode,
      trackBackground: true,
      onChange: (id) => setMode(id === 'play' ? 'play' : 'edit'),
    });
    modeHost.title = 'Edit: click an element to comment. Play: use the design like a prototype.';
    bscope.add(() => modeTabs.dispose());

    const pinsToggle = btn({ label: 'Pins', variant: 'ghost', size: 'xs', icon: 'comment', pressed: showPins, title: 'Show comment pins while playing', onClick: () => {
      showPins = !showPins;
      pinsToggle.set({ pressed: showPins });
      wall.setShowPins(showPins);
    } });
    pinsToggle.el.hidden = mode !== 'play' || artifact;

    const commentMode = btn({ label: 'Comment', variant: 'outline', size: 'sm', icon: 'cursor', pressed: false, title: 'Click an element to pin a comment to it', onClick: () => {
      if (artifactViewport === FILL) {
        toast('info', 'Comments attach to a device size. Pick one of the sizes in the list first.');
        return;
      }
      setMode(mode === 'edit' ? 'play' : 'edit');
    } });

    const setMode = (next: 'edit' | 'play'): void => {
      if (viewing) return;
      mode = next;
      wall.setMode(next);
      modeTabs.update({ activeId: next });
      commentMode.set({ pressed: next === 'edit' });
      pinsToggle.el.hidden = next !== 'play' || artifact;
    };

    const chipHost = h('div', { class: 'dc-chips', role: 'group', 'aria-label': 'Device sizes shown' });
    const paintChips = (): void => {
      chipHost.replaceChildren();
      for (const viewport of design().viewports) {
        const on = !hidden.has(viewport.id);
        const chip = btn({
          label: viewport.label,
          variant: 'outline',
          size: 'xs',
          pressed: on,
          title: `${viewportLabel(viewport)} — ${on ? 'click to hide' : 'click to show'}`,
          onClick: () => {
            const next = new Set(hidden);
            if (on) {
              if (design().viewports.length - next.size <= 1) {
                toast('info', 'Keep at least one device size visible.');
                return;
              }
              next.add(viewport.id);
            } else next.delete(viewport.id);
            hidden = next;
            wall.setHiddenViewports([...hidden]);
            savePrefs(wall.getCamera());
            paintChips();
          },
        });
        chip.el.dataset.chip = on ? 'on' : 'off';
        chipHost.append(chip.el, h('span', { class: 'dc-chip-size' }, viewportSize(viewport)));
      }
    };

    const viewportHost = h('div', { class: 'dc-viewport-select' });
    const viewportSelect = mountSelect(viewportHost, {
      label: undefined,
      value: artifactViewport,
      options: [],
      onChange: (id) => {
        artifactViewport = id;
        applyArtifactViewport();
      },
    });
    bscope.add(() => viewportSelect.dispose());
    let stageObserver: ResizeObserver | null = null;
    const applyArtifactViewport = (): void => {
      if (artifactViewport === FILL) {
        const rect = stage.getBoundingClientRect();
        const synthetic: Viewport = { id: FILL, label: 'Fill', width: Math.max(280, Math.round(rect.width - 48)), height: Math.max(280, Math.round(rect.height - 48)) };
        wall.setViewportOverride(synthetic);
        if (mode === 'edit') setMode('play');
      } else {
        wall.setViewportOverride(null);
        wall.setHiddenViewports(design().viewports.filter((viewport) => viewport.id !== artifactViewport).map((viewport) => viewport.id));
      }
      viewportSelect.update({ value: artifactViewport });
      wall.fit();
    };
    if (artifact) {
      stageObserver = new ResizeObserver(
        debounce(() => {
          if (artifactViewport === FILL) applyArtifactViewport();
        }, 150),
      );
      stageObserver.observe(stage);
      bscope.add(() => stageObserver?.disconnect());
    }
    const paintViewportOptions = (): void => {
      viewportSelect.update({
        options: [...design().viewports.map((viewport) => ({ id: viewport.id, label: viewport.label, hint: viewportSize(viewport) })), { id: FILL, label: 'Fill', hint: 'whole window' }],
        value: artifactViewport,
      });
    };

    const commentsButton = btn({ label: 'Comments', variant: 'outline', size: 'sm', icon: 'comment', onClick: () => toggleDrawer('comments') });
    const versionsButton = btn({ label: 'Versions', variant: 'outline', size: 'sm', icon: 'history', onClick: () => toggleDrawer('versions') });
    const chatButton = btn({ label: 'Continue in chat', variant: 'default', size: 'sm', icon: 'chat', onClick: () => void continueInChat(slug) });

    const exportMenu = btn({ label: 'Export', variant: 'outline', size: 'sm', icon: 'download', chevron: true, onClick: () => undefined });
    const copyMenu = btn({ label: 'Copy', variant: 'outline', size: 'sm', icon: 'copy', chevron: true, onClick: () => undefined });
    const moreButton = iconBtn({ icon: 'more', label: 'More actions', onClick: () => undefined });

    const doExport = async (format: 'zip' | 'html', screen?: string): Promise<void> => {
      const done = await exportDesign(slug, format, screen);
      if (!done) return;
      if (exported) clearTimeout(exported.timer);
      exported = { path: done.path, timer: setTimeout(() => { exported = null; paintNotices(); }, 15000) };
      paintNotices();
    };

    const pickScreenThenExport = (anchor: HTMLElement): void => {
      const screens = design().screens;
      if (screens.length <= 1) {
        void doExport('html', screens[0]?.id);
        return;
      }
      openMenu(anchor, screens.map((screen) => ({ id: screen.id, label: screen.title })), (id) => void doExport('html', id));
    };

    const ref = () => ({ slug, title: design().title, kind: design().kind, sessionId: design().sessionId });
    const rename = (): void => renameDialog(options.actions.host, ref());

    const baseEntries = (): MenuEntry[] => [
      { id: 'reveal', label: 'Reveal in folder' },
      { id: 'path', label: 'Copy path' },
      { id: 'rename', label: 'Rename' },
      { separator: true },
      { id: 'delete', label: 'Delete…', destructive: true },
    ];

    const moreEntries = (): MenuEntry[] => {
      if (compact) {
        return [
          { id: 'chat', label: 'Continue in chat' },
          { separator: true },
          { id: 'zip', label: artifact ? 'Export ZIP' : 'Export ZIP' },
          { id: 'html', label: artifact ? 'Export single-file HTML' : 'Export screen as HTML…' },
          ...(artifact ? [{ id: 'copy-html', label: 'Copy HTML', disabled: htmlChars !== null && htmlChars > HOST_CLIPBOARD_MAX, hint: htmlChars !== null && htmlChars > HOST_CLIPBOARD_MAX ? 'too large' : undefined } satisfies MenuEntry] : []),
          { id: 'path', label: 'Copy path' },
          { id: 'reveal', label: 'Reveal in folder' },
          { separator: true },
          { id: 'versions', label: 'Versions' },
          { id: 'comments', label: `Comments (${openCount()})` },
          { id: 'rename', label: 'Rename' },
          { separator: true },
          { id: 'delete', label: 'Delete…', destructive: true },
        ];
      }
      return artifact ? baseEntries() : [{ id: 'zip', label: 'Export ZIP' }, { id: 'html', label: 'Export screen as HTML…' }, { separator: true }, ...baseEntries()];
    };

    const onMore = (id: string): void => {
      switch (id) {
        case 'chat':
          void continueInChat(slug);
          return;
        case 'zip':
          void doExport('zip');
          return;
        case 'html':
          if (artifact) void doExport('html');
          else pickScreenThenExport(moreButton);
          return;
        case 'copy-html':
          void copyHtml(slug);
          return;
        case 'path':
          void copyPath(slug);
          return;
        case 'reveal':
          void revealDesign(slug);
          return;
        case 'versions':
          toggleDrawer('versions');
          return;
        case 'comments':
          toggleDrawer('comments');
          return;
        case 'rename':
          rename();
          return;
        case 'delete':
          confirmDelete(options.actions, ref());
          return;
      }
    };
    attachMenu(moreButton, moreEntries, onMore);
    attachMenu(
      exportMenu.el,
      () => [
        { id: 'zip', label: 'Download ZIP', hint: 'HTML + assets' },
        { id: 'html', label: 'Download single-file HTML', hint: 'assets inlined' },
      ],
      (id) => void doExport(id === 'zip' ? 'zip' : 'html'),
    );
    attachMenu(
      copyMenu.el,
      () => {
        const tooBig = htmlChars !== null && htmlChars > HOST_CLIPBOARD_MAX;
        return [
          { id: 'html', label: 'Copy HTML', disabled: tooBig, hint: tooBig ? 'too large to copy' : undefined },
          { id: 'path', label: 'Copy path' },
        ];
      },
      (id) => void (id === 'html' ? copyHtml(slug) : copyPath(slug)),
    );

    // ---------------------------------------------------------------- title
    const titleInput = h('input', { class: 'dc-title-input', type: 'text', 'aria-label': 'Design name', spellcheck: 'false', maxlength: '120' });
    titleInput.value = first.design.title;
    const commitTitle = async (): Promise<void> => {
      const next = titleInput.value.trim();
      if (next === design().title) return;
      try {
        await renameDesign(slug, next);
      } catch (error) {
        toast('error', `Couldn’t rename. ${errorText(error)}`);
        titleInput.value = design().title;
      }
    };
    titleInput.addEventListener('blur', () => void commitTitle());
    titleInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') titleInput.blur();
      else if (event.key === 'Escape') {
        titleInput.value = design().title;
        titleInput.blur();
      }
    });

    const titleText = h('h1', { class: 'dc-title-text', title: first.design.title }, first.design.title);

    // ---------------------------------------------------------------- toolbar layout
    const back = btn({ label: compact ? 'Designs' : 'Library', variant: 'ghost', size: 'sm', icon: 'back', onClick: options.onBack });
    let toolbar: HTMLElement;
    if (compact) {
      toolbar = h(
        'header',
        { class: 'dc-toolbar dc-toolbar-compact' },
        h('div', { class: 'dc-toolbar-row' }, iconBtn({ icon: 'back', label: 'Back to designs', onClick: options.onBack }), titleText, moreButton),
        h('div', { class: 'dc-toolbar-row dc-toolbar-tools' }, artifact ? viewportHost : modeHost, artifact ? commentMode.el : null, h('span', { class: 'dc-spacer' }), zoomGroup),
      );
    } else if (artifact) {
      toolbar = h(
        'header',
        { class: 'dc-toolbar' },
        h('div', { class: 'dc-toolbar-group' }, back.el, titleInput),
        h('div', { class: 'dc-toolbar-group' }, viewportHost, zoomGroup, commentMode.el),
        h('span', { class: 'dc-spacer' }),
        h('div', { class: 'dc-toolbar-group' }, versionsButton.el, exportMenu.el, copyMenu.el, chatButton.el, moreButton),
      );
    } else {
      toolbar = h(
        'header',
        { class: 'dc-toolbar' },
        h('div', { class: 'dc-toolbar-group' }, back.el, titleInput),
        h('div', { class: 'dc-toolbar-group' }, modeHost, pinsToggle.el, chipHost, zoomGroup),
        h('span', { class: 'dc-spacer' }),
        h('div', { class: 'dc-toolbar-group' }, commentsButton.el, versionsButton.el, chatButton.el, moreButton),
      );
    }

    // ---------------------------------------------------------------- notices
    const notices = h('div', { class: 'dc-notices', 'aria-live': 'polite' });
    const paintNotices = (): void => {
      notices.replaceChildren();
      if (viewing) {
        const row = versionsRow(viewing);
        notices.append(row);
      }
      const remote = wall.externalRefs();
      if (remote.length > 0 && !viewing) {
        notices.append(
          banner({
            tone: 'warning',
            title: `This page asks for ${remote.length === 1 ? 'a file' : `${remote.length} files`} from the internet`,
            body: 'Designs can’t load remote files here, so it may look unstyled. Your agent can make the page self-contained.',
            action: { label: 'Ask the agent to fix it', onClick: () => void askSelfContained(slug).then(() => toast('info', 'Asked the agent to make the page self-contained.'), (error: unknown) => toast('error', `Couldn’t send that. ${errorText(error)}`)) },
          }),
        );
      }
      if (exported) {
        const { path } = exported;
        notices.append(banner({ tone: 'success', title: 'Export saved', body: path, action: { label: 'Show in folder', onClick: () => void reveal(path) } }));
      }
    };

    const versionsRow = (current: { id: string; compare: boolean }): HTMLElement => {
      const number = Number(current.id.slice(1));
      const compareBtn = btn({ label: current.compare ? `View v${number} only` : 'Compare with current', variant: 'outline', size: 'xs', icon: 'compare', onClick: () => viewVersion(current.id, !current.compare) });
      const restoreBtn = btn({
        label: 'Restore',
        variant: 'outline',
        size: 'xs',
        onClick: () =>
          confirmRestoreVersion(options.actions.host, slug, { id: current.id, n: number }, () => leaveVersion()),
      });
      const backBtn = btn({ label: 'Back to current', variant: 'default', size: 'xs', onClick: () => leaveVersion() });
      const listBtn = compact ? btn({ label: 'Versions', variant: 'ghost', size: 'xs', onClick: () => toggleDrawer('versions') }) : null;
      return h('div', { class: 'dc-viewing', role: 'status' }, icon_(), h('span', { class: 'dc-viewing-text' }, viewingBanner(number, current.compare)), h('span', { class: 'dc-viewing-actions' }, compareBtn.el, restoreBtn.el, listBtn?.el ?? null, backBtn.el));
    };

    const icon_ = (): HTMLElement => h('span', { class: 'dc-viewing-dot', 'aria-hidden': 'true' });

    const viewVersion = (id: string, compare: boolean): void => {
      viewing = { id, compare };
      wall.setVersion(id, compare);
      modeTabs.update({ activeId: 'play' });
      modeHost.dataset.disabled = 'true';
      commentMode.el.disabled = true;
      paintNotices();
      (drawer?.kind === 'versions' ? (drawer.handle as VersionsHandle) : null)?.refresh();
    };

    const leaveVersion = (): void => {
      viewing = null;
      wall.setVersion(null, false);
      modeTabs.update({ activeId: mode });
      delete modeHost.dataset.disabled;
      commentMode.el.disabled = false;
      paintNotices();
      (drawer?.kind === 'versions' ? (drawer.handle as VersionsHandle) : null)?.refresh();
    };

    // ---------------------------------------------------------------- drawers
    const dock = h('aside', { class: 'dc-dock', hidden: true });
    dockEl = dock;
    const closeDrawer = (): void => {
      const current = drawer;
      drawer = null;
      current?.handle.dispose();
      current?.sheet.close();
      commentsButton.set({ pressed: false });
      versionsButton.set({ pressed: false });
      dock.hidden = true;
      wall.refit();
    };

    const toggleDrawer = (kind: 'comments' | 'versions'): void => {
      if (drawer?.kind === kind) {
        closeDrawer();
        return;
      }
      if (drawer) {
        const previous = drawer;
        drawer = null;
        previous.handle.dispose();
        previous.sheet.close();
      }
      const title = kind === 'comments' ? 'Comments' : 'Versions';
      const sheet = openSheet(compact ? options.actions.host : dock, {
        title,
        variant: compact ? 'full' : 'dock',
        onClose: () => {
          if (drawer?.sheet === sheet) {
            drawer.handle.dispose();
            drawer = null;
            commentsButton.set({ pressed: false });
            versionsButton.set({ pressed: false });
            dock.hidden = true;
            wall.refit();
          }
        },
      });
      let handle: CommentsHandle | VersionsHandle;
      if (kind === 'comments') {
        handle = mountComments({
          slug,
          detached: () => wall.detachedIds(),
          anchorStates: () => wall.anchorStates(),
          onLocate: (id) => {
            if (compact) closeDrawer();
            if (viewing) leaveVersion();
            if (artifact && mode !== 'edit') setMode('edit');
            wall.focusComment(id);
          },
        });
        sheet.body.append(handle.el);
        void store.refreshOpenDesign();
      } else {
        handle = mountVersions({
          slug,
          dialogHost: options.actions.host,
          viewing: () => viewing,
          onView: (id) => {
            viewVersion(id, false);
            if (compact) closeDrawer();
          },
          onCompare: (id) => {
            viewVersion(id, true);
            if (compact) closeDrawer();
          },
          onBackToCurrent: () => leaveVersion(),
          // The store reloads every artboard after a restore; leaving the version shows them.
          onRestored: () => leaveVersion(),
        });
        sheet.body.append(handle.el);
        void store.loadVersions(slug);
      }
      drawer = { kind, sheet, handle };
      dock.hidden = false;
      wall.refit();
      commentsButton.set({ pressed: kind === 'comments' });
      versionsButton.set({ pressed: kind === 'versions' });
    };

    // ---------------------------------------------------------------- data flow
    const openCount = (): number => design().comments.filter((comment) => comment.status === 'open').length;

    const refreshHtmlSize = (): void => {
      if (!artifact) return;
      void store.loadSource(slug).then(
        (source) => void (htmlChars = source.text.length),
        () => void (htmlChars = null),
      );
    };
    const refreshHtmlSizeSoon = debounce(refreshHtmlSize, 600);

    const apply = (next: DesignDetailResponse): void => {
      data = next;
      wall.setDetail(next);
      if (document.activeElement !== titleInput) titleInput.value = next.design.title;
      titleText.textContent = next.design.title;
      titleText.title = next.design.title;
      const count = openCount();
      commentsButton.set({ label: count > 0 ? `Comments · ${count}` : 'Comments' });
      paintChips();
      paintViewportOptions();
      paintNotices();
      if (!next.design.viewports.some((viewport) => viewport.id === artifactViewport) && artifactViewport !== FILL) {
        artifactViewport = next.design.viewports[0]?.id ?? FILL;
        if (artifact) applyArtifactViewport();
      }
    };

    // The store bumps a source's render revision when the agent changes its files.
    let revs = store.getState().renderRevs;
    bscope.add(
      store.subscribe((state) => {
        if (state.renderRevs === revs) return;
        const previous = revs;
        revs = state.renderRevs;
        const sources = artifact ? [null] : design().screens.map((screen) => screen.id);
        const changed = new Set(sources.filter((source) => revs[renderSourceKey(slug, source)] !== previous[renderSourceKey(slug, source)]));
        if (changed.size === 0) return;
        wall.reload(changed);
        refreshHtmlSizeSoon();
      }),
    );

    const main = h('div', { class: 'dc-design-main' }, stage, dock);
    replace(el, toolbar, notices, main, compact ? h('footer', { class: 'dc-hint' }, FULL_SCREEN_HINT) : null);
    apply(first);
    refreshHtmlSize();
    if (artifact) {
      commentMode.set({ pressed: mode === 'edit' });
      paintViewportOptions();
    }
    wall.fit();
    queueMicrotask(() => wall.focus());

    built = {
      apply,
      dispose: () => {
        closeDrawer();
        if (exported) clearTimeout(exported.timer);
        bscope.dispose();
        wall.dispose();
      },
    };
  };

  let lastApplied: DesignDetailResponse | null = null;
  const update = (): void => {
    if (disposed) return;
    const state = stateOf();
    if (built) {
      if (state?.data) {
        // The store notifies for every slot it loads; only a new answer for this design needs the wall.
        if (state.data !== lastApplied) {
          lastApplied = state.data;
          built.apply(state.data);
        }
      }
      else if (!state || (state.status === 'error' && isServiceError(state.error, 'not-found'))) {
        built.dispose();
        built = null;
        lastApplied = null;
        showMessage(h('p', { class: 'dc-empty-title' }, 'This design is gone'), h('p', { class: 'dc-empty-body' }, 'Its folder was moved or deleted. Pick another design from the list.'));
      }
      return;
    }
    if (building) return;
    if (!state || state.status === 'idle' || (state.status === 'loading' && !state.data)) {
      showMessage(loadingRow('Opening design…'));
      return;
    }
    if (state.data) {
      void build(state.data);
      return;
    }
    showMessage(banner({ tone: 'error', title: 'This design didn’t open', body: state.error?.message ?? 'The local service didn’t answer.', action: { label: 'Try again', onClick: () => void store.openDesign(slug) } }));
  };

  scope.add(store.subscribe(update));
  void store.openDesign(slug);
  update();

  return {
    el,
    dispose: () => {
      disposed = true;
      scope.dispose();
      built?.dispose();
      if (store.getState().open?.slug === slug) store.closeDesign();
      el.remove();
    },
  };
};
