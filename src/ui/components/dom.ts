// Tiny DOM helpers: element builder, disposal scope, async-action wrapper. Every string
// reaches the DOM through `textContent` / `setAttribute` — never `innerHTML`.

export type Child = Node | string | null | undefined | false;
export type Attrs = Record<string, string | number | boolean | null | undefined | ((event: Event) => void)>;

export const h = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (typeof value === 'function') node.addEventListener(key.replace(/^on/, '').toLowerCase(), value);
      else if (key === 'class') node.className = String(value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(node, ...children);
  return node;
};

export const append = (node: Element, ...children: Child[]): void => {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
};

export const replace = (node: Element, ...children: Child[]): void => {
  node.replaceChildren();
  append(node, ...children);
};

/** Collects disposers so a screen can tear everything down with one call. */
export type Scope = {
  add: <T extends () => void>(dispose: T) => T;
  /** Add a kit handle (or anything with `dispose`) and return it. */
  own: <T extends { dispose: () => void }>(handle: T) => T;
  listen: <E extends Event>(target: EventTarget, type: string, listener: (event: E) => void, options?: AddEventListenerOptions) => void;
  dispose: () => void;
};

export const createScope = (): Scope => {
  const disposers: Array<() => void> = [];
  const scope: Scope = {
    add: (dispose) => {
      disposers.push(dispose);
      return dispose;
    },
    own: (handle) => {
      disposers.push(() => handle.dispose());
      return handle;
    },
    listen: (target, type, listener, options) => {
      // Safe: the caller picks the event type that matches `E`; addEventListener's overloads cannot express that for a string type.
      const typed = listener as EventListener;
      target.addEventListener(type, typed, options);
      disposers.push(() => target.removeEventListener(type, typed, options));
    },
    dispose: () => {
      while (disposers.length > 0) disposers.pop()?.();
    },
  };
  return scope;
};

/** A sentence for any thrown value; services already throw user-facing messages. */
export const errorText = (error: unknown): string => (error instanceof Error && error.message !== '' ? error.message : 'Something unexpected happened. Try again.');

/** Runs `task` once at a time: ignores re-entry while it runs, reports start/end. */
export const singleFlight = <A extends unknown[]>(task: (...args: A) => Promise<void>, onBusy: (busy: boolean) => void): ((...args: A) => Promise<void>) => {
  let running = false;
  return async (...args) => {
    if (running) return;
    running = true;
    onBusy(true);
    try {
      await task(...args);
    } finally {
      running = false;
      onBusy(false);
    }
  };
};

export const debounce = <A extends unknown[]>(fn: (...args: A) => void, ms: number): ((...args: A) => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
};

let uid = 0;
export const nextId = (prefix: string): string => `${prefix}-${(uid += 1)}`;
