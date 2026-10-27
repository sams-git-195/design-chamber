// Settings (rail R3 and page P5): the designs folder, folders you used before, the browser that
// makes thumbnails, and the opencode.json tip. Same content in the rail sheet and the page sheet.

import { mountBadge, mountTextField } from '@openchamber/sdk/ui';

import type { SettingsResponse } from '../../shared/api.ts';
import { client, host, store } from '../guest.ts';
import { middlePath } from '../model/format.ts';
import { designCountLabel, browserStatus, permissionSnippet, validateRootInput } from '../model/settings-model.ts';
import { toast } from './actions.ts';
import { append, createScope, errorText, h } from './dom.ts';
import { banner, btn, loadingRow } from './kit.ts';

export type SettingsHandle = { dispose: () => void };

const section = (title: string, description: string, ...children: Array<Node | null>): HTMLElement =>
  h('section', { class: 'dc-settings-section' }, h('h3', { class: 'dc-settings-h' }, title), h('p', { class: 'dc-settings-p' }, description), ...children);

export const mountSettings = (container: HTMLElement): SettingsHandle => {
  const scope = createScope();
  const body = h('div', { class: 'dc-settings' });
  container.append(body);
  let version = '';
  void client.call('GET /health').then(
    (health) => {
      version = health.version;
      paint();
    },
    () => undefined,
  );

  // Field state survives repaints (a settings refresh must not wipe what is being typed).
  let rootDraft: string | null = null;
  let rootError: string | null = null;
  let chromeDraft: string | null = null;
  let chromeError: string | null = null;
  let rootBusy = false;
  let chromeBusy = false;
  let copied = false;

  const applyRoot = async (value: string | null, current: SettingsResponse): Promise<void> => {
    if (value !== null) {
      rootError = validateRootInput(value, current.root);
      if (rootError !== null) return paint();
    }
    rootBusy = true;
    rootError = null;
    paint();
    try {
      await store.updateSettings({ root: value === null ? null : value.trim() });
      rootDraft = null;
      await store.refreshDesigns();
      toast('success', 'Designs folder changed. Designs in the earlier folder stay where they were.');
    } catch (error) {
      rootError = errorText(error);
    } finally {
      rootBusy = false;
      paint();
    }
  };

  const switchBack = async (path: string): Promise<void> => {
    try {
      await store.updateSettings({ root: path });
      await store.refreshDesigns();
      toast('success', 'Switched back to that folder.');
    } catch (error) {
      toast('error', `Couldn’t switch back. ${errorText(error)}`);
    }
  };

  const applyChrome = async (value: string | null): Promise<void> => {
    chromeBusy = true;
    chromeError = null;
    paint();
    try {
      const next = await store.updateSettings({ chromePath: value === null ? null : value.trim() });
      if (value !== null && next.chrome.source !== 'setting') chromeError = 'That file isn’t a browser Design Chamber can use. Check the path and try again.';
      else {
        chromeDraft = null;
        toast('success', value === null ? 'Using the detected browser.' : 'That browser works. Thumbnails will use it.');
      }
    } catch (error) {
      chromeError = errorText(error);
    } finally {
      chromeBusy = false;
      paint();
    }
  };

  const copySnippet = async (snippet: string): Promise<void> => {
    if (await host.writeClipboard(snippet)) {
      copied = true;
      paint();
      setTimeout(() => {
        copied = false;
        paint();
      }, 2000);
    } else toast('error', 'Couldn’t reach the clipboard. Select the text and copy it by hand.');
  };

  const paint = (): void => {
    const state = store.getState().settings;
    body.replaceChildren();
    if (state.status === 'idle' || (state.status === 'loading' && !state.data)) {
      body.append(loadingRow('Loading settings…'));
      return;
    }
    if (!state.data) {
      body.append(banner({ tone: 'error', title: 'Settings didn’t load', body: state.error?.message ?? 'The local service didn’t answer.', action: { label: 'Try again', onClick: () => void store.loadSettings() } }));
      return;
    }
    const settings = state.data;

    // Designs folder
    const folderHost = h('div');
    const draft = rootDraft ?? settings.root;
    const folderField = mountTextField(folderHost, {
      label: 'Designs folder',
      value: draft,
      mono: true,
      disabled: rootBusy,
      error: rootError ?? undefined,
      helper: settings.rootExists ? 'Existing designs aren’t moved when you change this.' : 'This folder doesn’t exist yet. It is created when you apply.',
      onChange: (next) => {
        rootDraft = next;
        if (rootError !== null) {
          rootError = null;
          folderField.update({ error: undefined });
        }
      },
    });
    const apply = btn({ label: 'Apply folder', variant: 'default', loading: rootBusy, onClick: () => void applyRoot(rootDraft ?? settings.root, settings) });
    const reset = btn({ label: 'Use default', variant: 'ghost', disabled: rootBusy || settings.root === settings.defaultRoot, title: settings.defaultRoot, onClick: () => void applyRoot(null, settings) });
    folderHost.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
        event.preventDefault();
        void applyRoot(rootDraft ?? settings.root, settings);
      }
    });
    const folder = section('Where designs live', 'Your chat agent writes each design as its own folder here.', folderHost, h('div', { class: 'dc-row-actions' }, apply.el, reset.el));

    // Previous folders
    let previous: HTMLElement | null = null;
    if (settings.previousRoots.length > 0) {
      const rows = settings.previousRoots.map((root) => {
        const switchButton = btn({ label: 'Switch back', variant: 'outline', size: 'xs', disabled: !root.exists, title: root.exists ? undefined : 'This folder no longer exists.', onClick: () => void switchBack(root.path) });
        return h(
          'li',
          { class: 'dc-prev' },
          h('div', { class: 'dc-prev-text' }, h('code', { class: 'dc-path', title: root.path }, middlePath(root.path)), h('span', { class: 'dc-muted' }, root.exists ? `${designCountLabel(root.designCount)} remain here` : 'Folder not found')),
          switchButton.el,
        );
      });
      previous = section('Earlier folders', 'Designs in these folders were left in place. Switch back to see them again.', h('ul', { class: 'dc-prev-list' }, ...rows));
    }

    // Browser
    const status = browserStatus(settings.chrome.path, settings.chrome.source);
    const statusBadge = h('span');
    mountBadge(statusBadge, { label: status.title, tone: status.tone });
    const chromeHost = h('div');
    const chromeField = mountTextField(chromeHost, {
      label: 'Use a different browser',
      value: chromeDraft ?? '',
      mono: true,
      placeholder: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      disabled: chromeBusy,
      error: chromeError ?? undefined,
      helper: 'Optional. Chrome, Edge or Chromium; used only to take thumbnails.',
      onChange: (next) => {
        chromeDraft = next;
        if (chromeError !== null) {
          chromeError = null;
          chromeField.update({ error: undefined });
        }
      },
    });
    const test = btn({ label: 'Test and save', variant: 'outline', loading: chromeBusy, onClick: () => {
      if ((chromeDraft ?? '').trim() === '') {
        chromeError = 'Enter the path of a browser to test.';
        return paint();
      }
      void applyChrome(chromeDraft);
    } });
    const detected = btn({ label: 'Use detected', variant: 'ghost', disabled: chromeBusy || settings.chrome.source !== 'setting', onClick: () => void applyChrome(null) });
    const browser = section(
      'Browser for thumbnails',
      'A headless browser takes the previews. Without one, thumbnails fall back to live previews.',
      h('div', { class: 'dc-status-line' }, statusBadge, h('span', { class: 'dc-muted dc-status-detail' }, status.detail)),
      chromeHost,
      h('div', { class: 'dc-row-actions' }, test.el, detected.el),
    );

    // Permissions
    const snippet = permissionSnippet(settings.root);
    const copy = btn({ label: copied ? 'Copied' : 'Copy', variant: 'outline', size: 'sm', icon: copied ? 'check' : 'copy', onClick: () => void copySnippet(snippet) });
    const permissions = section(
      'Let your agent write here',
      'OpenCode asks before your agent writes outside the project. To allow your Designs folder once, add this to opencode.json. Design Chamber never edits that file.',
      h('pre', { class: 'dc-code', tabindex: '0', 'aria-label': 'opencode.json snippet' }, snippet),
      h('div', { class: 'dc-row-actions' }, copy.el),
    );

    append(body, folder, previous, browser, permissions, h('p', { class: 'dc-settings-foot' }, version ? `Design Chamber ${version.startsWith('v') ? version : `v${version}`}` : 'Design Chamber'));
  };

  // Repaint only when settings changed: other store traffic (the designs list) must not steal focus from a field being typed in.
  let seen = '';
  scope.add(
    store.subscribe(() => {
      const state = store.getState().settings;
      const signature = `${state.status}:${state.data ? JSON.stringify(state.data) : ''}:${state.error?.message ?? ''}`;
      if (signature === seen) return;
      seen = signature;
      paint();
    }),
  );
  void store.loadSettings();
  paint();
  return {
    dispose: () => {
      scope.dispose();
      body.remove();
    },
  };
};
