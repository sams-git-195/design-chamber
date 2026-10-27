// View-model of the designs list (rail R1, page P1): search, tabs, sort and the facts a row shows.

import type { DesignKind, DesignSummary } from '../../shared/types.ts';
import { plural } from './format.ts';

export type ListTab = 'all' | 'canvas' | 'artifact';
export type ListSort = 'updated' | 'created' | 'title';

export const LIST_TABS: ReadonlyArray<{ id: ListTab; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'canvas', label: 'Canvases' },
  { id: 'artifact', label: 'Artifacts' },
];

export const LIST_SORTS: ReadonlyArray<{ id: ListSort; label: string }> = [
  { id: 'updated', label: 'Updated' },
  { id: 'created', label: 'Created' },
  { id: 'title', label: 'Title' },
];

export const kindLabel = (kind: DesignKind): string => (kind === 'canvas' ? 'Canvas' : 'Artifact');

const matchesQuery = (design: DesignSummary, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return design.title.toLowerCase().includes(needle) || design.slug.toLowerCase().includes(needle);
};

const matchesTab = (design: DesignSummary, tab: ListTab): boolean => tab === 'all' || design.kind === tab;

export const filterDesigns = (designs: readonly DesignSummary[], query: string, tab: ListTab): DesignSummary[] =>
  designs.filter((design) => matchesTab(design, tab) && matchesQuery(design, query));

/** Counts per tab for the current search, so a tab never promises rows the search hides. */
export const tabCounts = (designs: readonly DesignSummary[], query: string): Record<ListTab, number> => {
  const searched = designs.filter((design) => matchesQuery(design, query));
  return {
    all: searched.length,
    canvas: searched.filter((design) => design.kind === 'canvas').length,
    artifact: searched.filter((design) => design.kind === 'artifact').length,
  };
};

export const sortDesigns = (designs: readonly DesignSummary[], sort: ListSort): DesignSummary[] => {
  const copy = [...designs];
  if (sort === 'title') return copy.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  const key = sort === 'created' ? 'created' : 'updated';
  return copy.sort((a, b) => Date.parse(b[key]) - Date.parse(a[key]));
};

/** "Canvas · 3 screens" / "Artifact" — the kind line of a row, without the time. */
export const kindSummary = (design: DesignSummary): string => {
  if (design.kind === 'artifact') return 'Artifact';
  return `Canvas · ${plural(design.screenCount, 'screen')}`;
};

export type EmptyKind = 'none' | 'no-designs' | 'no-matches';

/** Which empty state applies: nothing written yet, or a search/tab that hides everything. */
export const emptyKind = (all: readonly DesignSummary[], shown: readonly DesignSummary[]): EmptyKind => {
  if (shown.length > 0) return 'none';
  return all.length === 0 ? 'no-designs' : 'no-matches';
};

/** Plain sentence for the row's accessible name. */
export const rowAriaLabel = (design: DesignSummary): string => {
  const parts = [design.title, kindSummary(design)];
  if (design.pending) parts.push('waiting for the agent');
  if (design.openComments > 0) parts.push(plural(design.openComments, 'open comment'));
  return parts.join(', ');
};
