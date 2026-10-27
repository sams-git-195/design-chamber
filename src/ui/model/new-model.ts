// View-model of the New dialog: what is required, and the sentence that says what is missing.

import type { DesignKind } from '../../shared/types.ts';
import { BRIEF_MAX } from '../../shared/limits.ts';

export type Destination = 'new-chat' | 'current-chat';

export type NewForm = { kind: DesignKind; brief: string; preset: string | null; destination: Destination };

export const DESTINATIONS: ReadonlyArray<{ id: Destination; label: string; hint: string }> = [
  { id: 'new-chat', label: 'New chat', hint: 'Starts a chat in this project.' },
  { id: 'current-chat', label: 'Current chat', hint: 'Attaches the design to the chat you have open.' },
];

export const startLabel = (kind: DesignKind): string => (kind === 'canvas' ? 'Start canvas' : 'Start artifact');

/** Brief is optional — the agent asks when it is empty — so only the length can be wrong. */
export const validateBrief = (brief: string): string | null => (brief.length > BRIEF_MAX ? `Keep the brief under ${BRIEF_MAX} characters.` : null);

export const briefPlaceholder = (kind: DesignKind): string =>
  kind === 'canvas' ? 'e.g. A pricing page for a coffee subscription, laptop and phone' : 'e.g. A single-page invoice template I can print';

/** Presets list with the "no preset" choice first. */
export const presetOptions = (presets: ReadonlyArray<{ id: string; name: string; bestFor: string }>): Array<{ id: string; label: string; hint?: string }> => [
  { id: '', label: 'None — let the agent propose' },
  ...presets.map((preset) => ({ id: preset.id, label: preset.name, hint: preset.bestFor })),
];
