// Controls the SDK kit has no mount function for — icon buttons, buttons with a leading icon,
// icon-triggered menus, sheets and confirm dialogs — built from the kit's own classes
// (`oc-sdk-btn`, `oc-sdk-popup`, `oc-sdk-option`) so they look and focus like the kit's.

import { mountBanner, mountSpinner, moveListSelection, navigationKey, type BannerProps, type ButtonSize, type ButtonVariant } from '@openchamber/sdk/ui';

import { append, createScope, errorText, h, nextId, type Child } from './dom.ts';
import { icon, type IconName } from './icons.ts';

// ---------------------------------------------------------------- buttons

export type BtnOptions = {
  label: string;
  onClick: (event: MouseEvent) => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  chevron?: boolean;
  title?: string;
  disabled?: boolean;
  loading?: boolean;
  pressed?: boolean;
};

export type BtnHandle = { el: HTMLButtonElement; set: (next: Partial<Pick<BtnOptions, 'label' | 'disabled' | 'loading' | 'pressed' | 'title'>>) => void };

export const btn = (options: BtnOptions): BtnHandle => {
  const state = { ...options };
  const el = h('button', { type: 'button', class: 'oc-sdk oc-sdk-btn', 'data-variant': options.variant ?? 'outline', 'data-size': options.size ?? 'sm' });
  const label = h('span', { class: 'dc-btn-label' });
  const ring = h('span', { class: 'oc-sdk-spinner-ring', 'aria-hidden': 'true' });
  const paint = (): void => {
    label.textContent = state.label;
    el.disabled = Boolean(state.disabled) || Boolean(state.loading);
    el.dataset.loading = state.loading ? 'true' : 'false';
    el.setAttribute('aria-busy', state.loading ? 'true' : 'false');
    if (state.pressed !== undefined) el.setAttribute('aria-pressed', String(state.pressed));
    if (state.title) el.title = state.title;
    ring.hidden = !state.loading;
  };
  append(el, ring, options.icon ? icon(options.icon, 14) : null, label, options.chevron ? icon('chevron', 14) : null);
  el.addEventListener('click', (event) => {
    if (!state.disabled && !state.loading) state.onClick(event);
  });
  paint();
  return {
    el,
    set: (next) => {
      Object.assign(state, next);
      paint();
    },
  };
};

export type IconBtnOptions = { icon: IconName; label: string; onClick: (event: MouseEvent) => void; pressed?: boolean; size?: 'sm' | 'md'; disabled?: boolean };

/** A square, label-less button: the label is its accessible name and tooltip. */
export const iconBtn = (options: IconBtnOptions): HTMLButtonElement => {
  const el = h('button', { type: 'button', class: 'oc-sdk dc-iconbtn', 'data-size': options.size ?? 'md', 'aria-label': options.label, title: options.label, disabled: options.disabled });
  if (options.pressed !== undefined) el.setAttribute('aria-pressed', String(options.pressed));
  el.append(icon(options.icon, options.size === 'sm' ? 14 : 16));
  el.addEventListener('click', options.onClick);
  return el;
};

// ---------------------------------------------------------------- menus

export type MenuEntry = { id: string; label: string; hint?: string; destructive?: boolean; disabled?: boolean } | { separator: true };

type ActionEntry = Extract<MenuEntry, { id: string }>;
const actionsOf = (items: readonly MenuEntry[]): ActionEntry[] => items.filter((item): item is ActionEntry => 'id' in item);

let openMenuClose: (() => void) | null = null;

/** Opens a menu under `anchor`. Returns its closer. One menu at a time. */
export const openMenu = (anchor: HTMLElement, items: readonly MenuEntry[], onSelect: (id: string) => void): (() => void) => {
  openMenuClose?.();
  const uid = nextId('dc-menu');
  const popup = h('div', { class: 'oc-sdk oc-sdk-popup dc-popup', role: 'menu', tabindex: '-1', 'aria-label': anchor.getAttribute('aria-label') ?? undefined });
  let activeId: string | null = null;
  const rows = new Map<string, HTMLButtonElement>();

  const setActive = (id: string | null): void => {
    activeId = id;
    for (const [rowId, row] of rows) row.dataset.active = rowId === id ? 'true' : 'false';
    const row = id ? rows.get(id) : undefined;
    if (row) {
      popup.setAttribute('aria-activedescendant', row.id);
      row.scrollIntoView({ block: 'nearest' });
    } else popup.removeAttribute('aria-activedescendant');
  };

  let closed = false;
  const close = (restoreFocus = true): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('resize', onDismiss);
    window.removeEventListener('blur', onDismiss);
    popup.remove();
    anchor.setAttribute('aria-expanded', 'false');
    if (openMenuClose === close) openMenuClose = null;
    if (restoreFocus) anchor.focus();
  };
  const onDismiss = (): void => close(false);
  const onOutside = (event: PointerEvent): void => {
    if (event.target instanceof Node && (popup.contains(event.target) || anchor.contains(event.target))) return;
    close(false);
  };
  const pick = (id: string): void => {
    close();
    onSelect(id);
  };

  for (const item of items) {
    if (!('id' in item)) {
      popup.append(h('div', { class: 'oc-sdk-separator', 'data-labeled': 'false' }));
      continue;
    }
    const row = h(
      'button',
      { type: 'button', role: 'menuitem', tabindex: '-1', id: `${uid}-${item.id}`, class: 'oc-sdk-option', 'data-destructive': item.destructive ? 'true' : 'false', disabled: item.disabled },
      h('span', { class: 'oc-sdk-option-label' }, item.label),
      item.hint ? h('span', { class: 'oc-sdk-option-hint' }, item.hint) : null,
    );
    row.addEventListener('pointerenter', () => setActive(item.id));
    row.addEventListener('click', () => pick(item.id));
    rows.set(item.id, row);
    popup.append(row);
  }

  popup.addEventListener('keydown', (event) => {
    const step = navigationKey(event);
    if (step) {
      event.preventDefault();
      setActive(moveListSelection(actionsOf(items), activeId, step));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (activeId) pick(activeId);
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      close();
    }
  });

  document.body.append(popup);
  const rect = anchor.getBoundingClientRect();
  popup.style.minWidth = `${Math.max(176, Math.round(rect.width))}px`;
  popup.style.left = `${Math.round(rect.left)}px`;
  popup.style.top = `${Math.round(rect.bottom + 4)}px`;
  const height = popup.offsetHeight;
  const below = window.innerHeight - rect.bottom - 8;
  if (height > below && rect.top - 8 > below) popup.style.top = `${Math.max(8, Math.round(rect.top - 4 - height))}px`;
  const overflow = rect.left + popup.offsetWidth - window.innerWidth + 8;
  if (overflow > 0) popup.style.left = `${Math.max(8, Math.round(rect.left - overflow))}px`;

  document.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('resize', onDismiss);
  window.addEventListener('blur', onDismiss);
  anchor.setAttribute('aria-haspopup', 'menu');
  anchor.setAttribute('aria-expanded', 'true');
  openMenuClose = close;
  setActive(actionsOf(items).find((item) => !item.disabled)?.id ?? null);
  popup.focus();
  return close;
};

/** Attach a menu to a trigger: click toggles. `items` is read at open time so it can depend on current state. */
export const attachMenu = (trigger: HTMLElement, items: () => readonly MenuEntry[], onSelect: (id: string) => void): void => {
  let close: (() => void) | null = null;
  trigger.addEventListener('click', () => {
    if (trigger.getAttribute('aria-expanded') === 'true') {
      close?.();
      close = null;
      return;
    }
    close = openMenu(trigger, items(), onSelect);
  });
};

// ---------------------------------------------------------------- banners and loading rows

/** Mounts a kit banner into a fresh wrapper and returns the wrapper with its handle. */
export const banner = (props: BannerProps): HTMLElement => {
  const wrap = h('div', { class: 'dc-banner' });
  mountBanner(wrap, props);
  return wrap;
};

export const loadingRow = (label: string): HTMLElement => {
  const wrap = h('div', { class: 'dc-loading' });
  mountSpinner(wrap, { label });
  return wrap;
};

// ---------------------------------------------------------------- sheets and dialogs

export type SheetVariant = 'full' | 'side' | 'dialog' | 'dock';

export type SheetOptions = { title: string; variant: SheetVariant; onClose?: () => void; subtitle?: string };

export type SheetHandle = {
  el: HTMLElement;
  body: HTMLElement;
  foot: HTMLElement;
  setTitle: (title: string) => void;
  close: () => void;
};

type ModalEntry = { panel: HTMLElement; dismiss: () => void };
const modalStack: ModalEntry[] = [];
let modalKeysInstalled = false;

/** One document-level handler for the top-most modal sheet: Escape closes it, Tab stays inside it, wherever focus is. */
const installModalKeys = (): void => {
  if (modalKeysInstalled) return;
  modalKeysInstalled = true;
  document.addEventListener('keydown', (event) => {
    const top = modalStack[modalStack.length - 1];
    if (!top || event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      top.dismiss();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = Array.from(top.panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((node) => node.offsetParent !== null);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (!(active instanceof Node) || !top.panel.contains(active)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });
};

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * A panel over (`full`, `side`, `dialog`) or inside (`dock`) `host`. Modal variants trap Tab, close on
 * Escape and on a scrim click, and give focus back to what opened them.
 */
export const openSheet = (host: HTMLElement, options: SheetOptions): SheetHandle => {
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const titleId = nextId('dc-sheet-title');
  const modal = options.variant !== 'dock';
  const title = h('h2', { class: 'dc-sheet-title', id: titleId }, options.title);
  const close = h('button', { type: 'button', class: 'oc-sdk dc-iconbtn', 'aria-label': `Close ${options.title.toLowerCase()}`, title: 'Close' }, icon('close', 16));
  const body = h('div', { class: 'dc-sheet-body' });
  const foot = h('div', { class: 'dc-sheet-foot' });
  const panel = h(
    'section',
    { class: 'dc-sheet-panel', role: modal ? 'dialog' : 'region', 'aria-modal': modal ? 'true' : null, 'aria-labelledby': titleId, tabindex: '-1' },
    h('header', { class: 'dc-sheet-head' }, h('div', { class: 'dc-sheet-heading' }, title, options.subtitle ? h('p', { class: 'dc-sheet-sub' }, options.subtitle) : null), close),
    body,
    foot,
  );
  const scrim = modal && options.variant !== 'full' ? h('div', { class: 'dc-sheet-scrim' }) : null;
  const el = h('div', { class: 'dc-sheet', 'data-variant': options.variant }, scrim, panel);

  const scope = createScope();
  let closed = false;
  const dismiss = (): void => {
    if (closed) return;
    closed = true;
    scope.dispose();
    el.remove();
    options.onClose?.();
    if (modal) returnFocus?.focus();
  };
  close.addEventListener('click', dismiss);
  scrim?.addEventListener('pointerdown', dismiss);
  // Non-modal docks close on Escape only while focus is inside them; modal sheets use the shared document handler below.
  if (!modal) {
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        dismiss();
      }
    });
  } else {
    const entry: ModalEntry = { panel, dismiss };
    modalStack.push(entry);
    scope.add(() => modalStack.splice(modalStack.indexOf(entry), 1));
    installModalKeys();
  }
  host.append(el);
  queueMicrotask(() => {
    const first = body.querySelector<HTMLElement>('input,textarea,select,button');
    (first ?? panel).focus({ preventScroll: true });
  });
  return { el, body, foot, setTitle: (next) => void (title.textContent = next), close: dismiss };
};

export type ConfirmOptions = {
  title: string;
  body: Child;
  confirmLabel: string;
  destructive?: boolean;
  /** Throw a user-facing Error to keep the dialog open and show it. */
  onConfirm: () => Promise<void>;
};

/** One small modal: a sentence, the verb it will do, and a way out. Shows progress and failure itself. */
export const confirmDialog = (host: HTMLElement, options: ConfirmOptions): void => {
  const sheet = openSheet(host, { title: options.title, variant: 'dialog' });
  const failure = h('p', { class: 'dc-form-error', role: 'alert', hidden: true });
  sheet.body.append(h('div', { class: 'dc-confirm-body' }, options.body), failure);
  const cancel = btn({ label: 'Cancel', variant: 'ghost', onClick: () => sheet.close() });
  const confirm = btn({
    label: options.confirmLabel,
    variant: options.destructive ? 'destructive' : 'default',
    onClick: () => {
      confirm.set({ loading: true });
      cancel.set({ disabled: true });
      failure.hidden = true;
      options.onConfirm().then(
        () => sheet.close(),
        (error: unknown) => {
          failure.textContent = errorText(error);
          failure.hidden = false;
          confirm.set({ loading: false });
          cancel.set({ disabled: false });
        },
      );
    },
  });
  sheet.foot.append(cancel.el, confirm.el);
};
