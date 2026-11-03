/**
 * Where a bitmap sits in a text frame.
 *
 * The TUI composes a frame as an array of strings and writes only the rows that changed, each addressed
 * absolutely. A bitmap breaks that model twice: it is not text, so it cannot live in a row's bytes, and it
 * is more than one row tall, so the rows under it must stay blank or the next repaint paints over it.
 *
 * So a row that carries an image is written as a sentinel — a single private-use character plus the
 * payload — and this module turns a frame into the bytes that place it: address the row, emit the
 * sequence, then remember which rows the image covers so the following text rows can be skipped.
 *
 * A SIXEL PAYLOAD DRAWN INLINE IS JUST CHARACTERS. That is why the first attempt showed nothing: the
 * terminal consumed the bytes as text, scrolled them, and the formula never appeared. Placement needs a
 * cursor move first, which is what `\x1b[<row>;<col>H` does.
 */

/** Marks a row whose content is a placed bitmap. A private-use code point no text will contain. */
export const IMAGE_MARK = '\u0001IMG:';

/**
 * Separates the payload from the source that produced it.
 *
 * NOT A NUL BYTE. `SPIN_PLACEHOLDER` in the transcript renderer is `\u0000`, and every row is run through a
 * substitution that replaces it with the spinner frame — so a tag built on it arrived as `⠋SRC:…` and the
 * source was unreadable. `\u0001` is what `IMAGE_MARK` already uses and nothing substitutes it.
 */
export const SOURCE_TAG = '\u0001SRC:';


/**
 * Encode an image row: the mark, then the payload and its geometry, base64-free but length-prefixed so a
 * payload containing the mark cannot be misparsed.
 *
 * `source` is optional and travels with the row for pictures that can be REGENERATED: a formula that straddles
 * the top of the window must be redrawn from its first visible row, and only its TeX can produce that raster.
 * It is stored last, after the sequence, so a row written before this field existed still parses.
 *
 * @param {string} sequence The terminal sequence to emit.
 * @param {number} rows Rows of text the image covers.
 * @param {number} cols Columns the image covers.
 * @param {string} [source] What produced the sequence, for a picture that may need cropping later.
 */
export function encodeImageRow(sequence, rows, cols, source) {
  const head = IMAGE_MARK + rows + ':' + cols + ':';
  return typeof source === 'string' && source !== ''
    ? head + sequence + SOURCE_TAG + source
    : head + sequence;
}

/**
 * True when a composed row is an image rather than text.
 *
 * The row may carry the transcript's indent prefix — `messageLines` gives every line one — so the marker is
 * not necessarily at index 0. Matching it anywhere in the first few characters is what makes this work
 * without the row builder having to special-case images.
 */
export function isImageRow(line) {
  if (typeof line !== 'string') return false;
  const at = line.indexOf(IMAGE_MARK);
  return at >= 0 && at < 8 && /^\s*$/.test(line.slice(0, at));
}

/**
 * Split an image row back into its parts.
 * @returns {{sequence: string, rows: number, cols: number, source: string}|null}
 */
export function parseImageRow(line) {
  if (!isImageRow(line)) return null;
  const at = line.indexOf(IMAGE_MARK);
  const rest = line.slice(at + IMAGE_MARK.length);
  const firstColon = rest.indexOf(':');
  if (firstColon < 0) return null;
  const secondColon = rest.indexOf(':', firstColon + 1);
  if (secondColon < 0) return null;
  const rows = Number(rest.slice(0, firstColon));
  const cols = Number(rest.slice(firstColon + 1, secondColon));
  if (!Number.isFinite(rows) || !Number.isFinite(cols)) return null;
  let body = rest.slice(secondColon + 1);
  let source = '';
  const tag = body.lastIndexOf(SOURCE_TAG);
  if (tag >= 0) {
    source = body.slice(tag + SOURCE_TAG.length);
    body = body.slice(0, tag);
  }
  return { rows, cols, sequence: body, source };
}


/**
 * The bytes that place one image at its row, and how many rows it covers.
 *
 * @param {string} line The image row.
 * @param {number} rowIndex 0-based screen row the row was composed for.
 * @param {string} reset SGR reset to restore after the sequence.
 * @returns {{bytes: string, covered: number}|null}
 */
export function imageBytes(line, rowIndex, reset) {
  const parsed = parseImageRow(line);
  if (!parsed) return null;

  // DEC PRIVATE MODE 80 IS THE SIXEL SCROLLING MODE.
  //
  // With it enabled (the default) a terminal that draws a bitmap pushes the text below it down — and in a
  // full-screen TUI every bitmap therefore scrolls the whole interface. That is what produced the repeated
  // composer: each formula shoved the frame up and the next paint drew it again further down.
  //
  // `?80l` turns the mode off for the duration of the draw and `?80h` restores it. dsh-tui wraps its own
  // placement the same way.
  const bytes = `\x1b[?80l\x1b[${rowIndex + 1};1H${reset}${parsed.sequence}\x1b[?80h`;
  return { bytes, covered: parsed.rows };
}
