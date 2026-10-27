// Bundled style presets (rules/presets/<id>.md, docs/SPEC.md §7 `GET /presets`).
// Each file starts with `# Name` and a line `**id:** <id> · **best for:** <text>`.

import { PRESET_ID_PATTERN } from '../limits.ts';
import type { Preset } from '../types.ts';

const ID_LINE = /^\*\*id:\*\*\s*([^\s·]+)\s*·\s*\*\*best for:\*\*\s*(.+?)\s*$/;
const HEAD_LINES = 6;

/**
 * Parse one preset file. `fileStem` is the file name without `.md`; the id inside must equal it,
 * because the service finds a preset's text by `rules/presets/<id>.md`. `null` = not a preset.
 */
export const parsePreset = (fileStem: string, text: string): Preset | null => {
  const head = text.split(/\r?\n/, HEAD_LINES);
  const name = head.map((line) => /^#\s+(.+?)\s*$/.exec(line)?.[1]).find((value) => value !== undefined);
  const idLine = head.map((line) => ID_LINE.exec(line)).find((match) => match !== null && match !== undefined);
  const id = idLine?.[1];
  const bestFor = idLine?.[2];
  if (!name || !id || !bestFor) return null;
  if (id !== fileStem || !PRESET_ID_PATTERN.test(id)) return null;
  return { id, name, bestFor };
};
