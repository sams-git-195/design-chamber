// A design's thumbnail: the cached PNG when the service has one, a live scaled preview of the
// first screen when it has not (no browser installed, or the capture failed), and a kind
// glyph while the agent has not written anything yet. Live previews are lazy and capped.

import { createFrameDocument, type FrameDocument } from '../../guest/frame-doc.ts';
import { client } from '../guest.ts';
import type { DesignSummary } from '../../shared/types.ts';
import { h } from './dom.ts';
import { icon } from './icons.ts';

export type ThumbHandle = { el: HTMLElement; update: (summary: DesignSummary) => void; dispose: () => void };

const LIVE_MAX = 6;
let liveActive = 0;
const liveWaiting: Array<() => void> = [];

const acquireLive = (start: () => void): (() => void) => {
  const release = (): void => {
    liveActive -= 1;
    liveWaiting.shift()?.();
  };
  const begin = (): void => {
    liveActive += 1;
    start();
  };
  if (liveActive < LIVE_MAX) begin();
  else liveWaiting.push(begin);
  return () => {
    const queued = liveWaiting.indexOf(begin);
    if (queued >= 0) liveWaiting.splice(queued, 1);
    else release();
  };
};

type Mode = 'pending' | 'image' | 'live';

const modeOf = (summary: DesignSummary): Mode => (summary.pending ? 'pending' : summary.thumb.state === 'ready' ? 'image' : 'live');

export const mountThumb = (summary: DesignSummary, aspect: 'rail' | 'card' = 'rail'): ThumbHandle => {
  let current = summary;
  const el = h('div', { class: 'dc-thumb', 'data-aspect': aspect, 'data-state': 'loading', 'aria-hidden': 'true' });
  let disposed = false;
  let teardown: (() => void) | null = null;
  let sizeObserver: ResizeObserver | null = null;
  let observer: IntersectionObserver | null = null;
  let token = 0;

  const clear = (): void => {
    teardown?.();
    teardown = null;
    sizeObserver?.disconnect();
    sizeObserver = null;
    observer?.disconnect();
    observer = null;
    el.replaceChildren();
  };

  const showPending = (): void => {
    el.dataset.state = 'pending';
    el.append(icon(current.kind === 'canvas' ? 'canvas' : 'artifact', aspect === 'card' ? 28 : 18));
  };

  const showImage = (): void => {
    el.dataset.state = 'loading';
    const mine = token;
    const key = current.thumb.key;
    client.thumbnail(current.slug, key).then(
      (answer) => {
        if (disposed || mine !== token) return;
        if (answer.state === 'ready' && answer.png) {
          const img = h('img', { alt: '', draggable: 'false', src: `data:image/png;base64,${answer.png}` });
          img.addEventListener('load', () => void (el.dataset.state = 'ready'), { once: true });
          el.append(img);
        } else showLive();
      },
      () => {
        if (!disposed && mine === token) showLive();
      },
    );
  };

  const showLive = (): void => {
    clear();
    el.dataset.state = 'loading';
    const mine = token;
    const place = (): void => {
      let doc: FrameDocument | null = null;
      let release: (() => void) | null = null;
      const start = (): void => {
        const vp = current.viewports[0] ?? { width: 1280, height: 800, id: 'laptop', label: 'Laptop' };
        client.loadRender(current.slug, null, null).then(
          ({ html }) => {
            if (disposed || mine !== token) return;
            doc = createFrameDocument(html, { artboardId: 'thumb', file: current.kind === 'artifact' ? 'index.html' : 'thumb', mode: 'play' });
            const frame = h('iframe', { class: 'dc-thumb-frame', sandbox: '', tabindex: '-1', title: '', src: doc.url, loading: 'eager' });
            frame.style.width = `${vp.width}px`;
            frame.style.height = `${vp.height}px`;
            const fit = (): void => {
              const scale = el.clientWidth / vp.width;
              if (scale > 0) frame.style.transform = `scale(${scale})`;
            };
            fit();
            sizeObserver = new ResizeObserver(fit);
            sizeObserver.observe(el);
            frame.addEventListener('load', () => void (el.dataset.state = 'ready'), { once: true });
            el.append(frame);
          },
          () => {
            if (!disposed && mine === token) el.dataset.state = 'error';
          },
        );
      };
      release = acquireLive(start);
      teardown = () => {
        release?.();
        doc?.revoke();
        el.replaceChildren();
      };
    };
    observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer?.disconnect();
        observer = null;
        place();
      }
    });
    observer.observe(el);
  };

  const render = (): void => {
    token += 1;
    clear();
    const mode = modeOf(current);
    if (mode === 'pending') showPending();
    else if (mode === 'image') showImage();
    else showLive();
  };

  render();

  return {
    el,
    update: (next) => {
      const changed = modeOf(next) !== modeOf(current) || next.thumb.key !== current.thumb.key || next.slug !== current.slug;
      current = next;
      if (changed) render();
    },
    dispose: () => {
      disposed = true;
      clear();
      el.remove();
    },
  };
};
