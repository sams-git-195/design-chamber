// Line icons (24×24 grid, stroke = currentColor) for the glyphs the SDK kit does not ship.
// Shapes follow the common outline-icon vocabulary so they sit next to the app's own icons.

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICONS = {
  back: ['M19 12H5', 'm12 19-7-7 7-7'],
  plus: ['M5 12h14', 'M12 5v14'],
  minus: ['M5 12h14'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  chevron: ['m6 9 6 6 6-6'],
  close: ['M18 6 6 18', 'm6 6 12 12'],
  check: ['M20 6 9 17l-5-5'],
  settings: ['M4 6h8', 'M16 6h4', 'M14 4v4', 'M4 12h2', 'M10 12h10', 'M8 10v4', 'M4 18h10', 'M18 18h2', 'M16 16v4'],
  comment: ['M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  history: ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5', 'M12 7v5l3 2'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5', 'M12 15V3'],
  copy: ['M9 9h11a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z', 'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1'],
  external: ['M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', 'm15 3 6 0 0 6', 'M10 14 21 3'],
  cursor: ['M4 4l7.07 16.97 2.51-7.39 7.39-2.51L4 4z'],
  play: ['m7 4 13 8-13 8z'],
  fit: ['M8 3H5a2 2 0 0 0-2 2v3', 'M21 8V5a2 2 0 0 0-2-2h-3', 'M3 16v3a2 2 0 0 0 2 2h3', 'M16 21h3a2 2 0 0 0 2-2v-3'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  canvas: ['M3 3h8v8H3z', 'M13 3h8v5h-8z', 'M13 10h8v11h-8z', 'M3 13h8v8H3z'],
  artifact: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5', 'm10 13-2 2 2 2', 'm14 13 2 2-2 2'],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
  pencil: ['M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z', 'm14 6 4 4'],
  link: ['M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1', 'M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1'],
  chat: ['M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12z'],
  compare: ['M6 3v12', 'M18 9v12', 'M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', 'M18 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', 'M13 6h-2a3 3 0 0 0-3 3', 'M11 18h2a3 3 0 0 0 3-3'],
  restore: ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5'],
  hand: ['M8 13V5a1.5 1.5 0 0 1 3 0v6', 'M11 11V4a1.5 1.5 0 0 1 3 0v7', 'M14 11V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7h-1a6 6 0 0 1-5-3l-2-4a1.5 1.5 0 0 1 2.5-1.6L8 14'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
  reset: ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5'],
  alert: ['M12 3 2 20h20z', 'M12 10v5', 'M12 18h.01'],
  image: ['M4 5h16v14H4z', 'M4 16l5-5 4 4 3-3 4 4', 'M9 9h.01'],
  warning: ['M12 3 2 20h20z', 'M12 10v4', 'M12 17h.01'],
  send: ['M22 2 11 13', 'M22 2l-7 20-4-9-9-4z'],
  pin: ['M12 21s-7-5.2-7-11a7 7 0 1 1 14 0c0 5.8-7 11-7 11z', 'M12 7.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z'],
  layers: ['m12 3 9 5-9 5-9-5z', 'm3 13 9 5 9-5'],
} as const satisfies Record<string, readonly string[]>;

export type IconName = keyof typeof ICONS;

export const icon = (name: IconName, size = 16): SVGSVGElement => {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('dc-icon');
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
};
