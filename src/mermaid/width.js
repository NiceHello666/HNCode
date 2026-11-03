/**
 * Display width for the diagram layout.
 *
 * The diagram engine measures a box in columns so its border lands on the right
 * cell. `src/term.js` already answers that question for the rest of the UI, with
 * the same grapheme clustering, so this module delegates rather than carrying a
 * second Unicode table (the upstream one is 25 KB).
 */
import { visualWidth } from '../term.js';
/** Columns occupied by one grapheme cluster. */
export function clusterWidth(cluster) {
  return visualWidth(cluster);
}

/**
 * Iterate clusters paired with their display width.
 *
 * Callers paint from this rather than by code point: a CJK character claims two
 * cells of layout but contributes one character of output.
 */
export function* measured(s) {
  const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
  for (const { segment } of seg.segment(s)) yield [segment, visualWidth(segment)];
}

/** Display columns of a string. */
export function stringWidth(s) {
  return visualWidth(s);
}
