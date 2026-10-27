// New dialog: kind, brief, style preset, and which chat the agent works in. One primary action.

import { mountSelect, mountTabs, mountTextField } from '@openchamber/sdk/ui';

import type { DesignKind } from '../../shared/types.ts';
import { flows, host, store } from '../guest.ts';
import { DESTINATIONS, briefPlaceholder, presetOptions, startLabel, validateBrief, type Destination } from '../model/new-model.ts';
import { errorText, h } from './dom.ts';
import { btn, openSheet } from './kit.ts';
import { toast } from './actions.ts';

export type NewDialogOptions = {
  kind: DesignKind;
  onCreated: (slug: string) => void;
};

export const openNewDialog = (hostEl: HTMLElement, options: NewDialogOptions): void => {
  let unsubscribe = (): void => {};
  const sheet = openSheet(hostEl, { title: 'New design', variant: 'dialog', subtitle: 'Your chat agent writes the files; they appear here as it works.', onClose: () => unsubscribe() });
  let kind = options.kind;
  let brief = '';
  let preset = '';
  let destination: Destination = 'new-chat';

  const kindHost = h('div', { class: 'dc-field' }, h('span', { class: 'oc-sdk-field-label' }, 'Type'));
  const kindTabs = mountTabs(kindHost, {
    items: [
      { id: 'canvas', label: 'Canvas' },
      { id: 'artifact', label: 'Artifact' },
    ],
    activeId: kind,
    trackBackground: true,
    onChange: (id) => {
      kind = id === 'artifact' ? 'artifact' : 'canvas';
      kindTabs.update({ activeId: kind });
      kindHint.textContent = kind === 'canvas' ? 'A wall of screens at several device sizes, with comments and versions.' : 'One HTML page you can export as a ZIP or a single file.';
      briefField.update({ placeholder: briefPlaceholder(kind) });
      submit.set({ label: startLabel(kind) });
    },
  });
  const kindHint = h('p', { class: 'oc-sdk-field-note' }, kind === 'canvas' ? 'A wall of screens at several device sizes, with comments and versions.' : 'One HTML page you can export as a ZIP or a single file.');
  kindHost.append(kindHint);

  const briefHost = h('div');
  const briefField = mountTextField(briefHost, {
    label: 'What should it be?',
    value: brief,
    multiline: true,
    rows: 4,
    placeholder: briefPlaceholder(kind),
    helper: 'Optional. Leave it empty and the agent will ask.',
    onChange: (next) => {
      brief = next;
      briefField.update({ error: validateBrief(next) ?? undefined });
    },
  });

  const presetHost = h('div', { class: 'dc-field' });
  const presetSelect = mountSelect(presetHost, { label: 'Style preset', value: '', options: presetOptions([]), disabled: true, onChange: (id) => void (preset = id) });
  const presetNote = h('p', { class: 'oc-sdk-field-note', hidden: true });
  presetHost.append(presetNote);
  const paintPresets = (): void => {
    const state = store.getState().presets;
    if (state.status === 'ready' && state.data) presetSelect.update({ options: presetOptions(state.data.presets), disabled: false, value: preset });
    if (state.status === 'error') {
      presetNote.textContent = 'Style presets didn’t load, so the agent will choose the style. You can still start.';
      presetNote.hidden = false;
    }
  };
  unsubscribe = store.subscribe(paintPresets);
  void store.loadPresets();
  paintPresets();

  const destHost = h('div', { class: 'dc-field' }, h('span', { class: 'oc-sdk-field-label' }, 'Where should the agent work?'));
  const destTabs = mountTabs(destHost, {
    items: DESTINATIONS.map(({ id, label }) => ({ id, label })),
    activeId: destination,
    trackBackground: true,
    onChange: (id) => {
      destination = id === 'current-chat' ? 'current-chat' : 'new-chat';
      destTabs.update({ activeId: destination });
      paintDest();
    },
  });
  const destHint = h('p', { class: 'oc-sdk-field-note' });
  destHost.append(destHint);
  const paintDest = (): void => {
    const base = DESTINATIONS.find((entry) => entry.id === destination)?.hint ?? '';
    const noSession = destination === 'current-chat' && host.session() === null;
    destHint.textContent = noSession ? 'No chat is open right now — choose New chat, or open one first.' : base;
  };
  paintDest();

  const failure = h('p', { class: 'dc-form-error', role: 'alert', hidden: true });
  const cancel = btn({ label: 'Cancel', variant: 'ghost', onClick: () => sheet.close() });
  const submit = btn({
    label: startLabel(kind),
    variant: 'default',
    onClick: () => {
      const problem = validateBrief(brief);
      if (problem !== null) {
        briefField.update({ error: problem });
        return;
      }
      failure.hidden = true;
      submit.set({ loading: true });
      cancel.set({ disabled: true });
      flows.newDesign({ kind, brief, preset: preset === '' ? null : preset, destination }).then(
        ({ slug }) => {
          toast('success', 'Design started. It shows up in your list while the agent works.');
          sheet.close();
          options.onCreated(slug);
        },
        (error: unknown) => {
          failure.textContent = errorText(error);
          failure.hidden = false;
          submit.set({ loading: false });
          cancel.set({ disabled: false });
        },
      );
    },
  });

  sheet.body.append(kindHost, briefHost, presetHost, destHost, failure);
  sheet.foot.append(cancel.el, submit.el);
};
