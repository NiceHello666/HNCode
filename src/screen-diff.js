/**
 * Two screens in, the bytes that turn one into the other.
 *
 * This is the writer the TUI paints through. Its whole job is to emit as little as possible: for each row that
 * differs, jump to its first changed column and write only the run that changed, carrying styles across the
 * run and resetting between them.
 *
 * WHY NOT REWRITE WHOLE ROWS
 * --------------------------
 * The previous painter rewrote a changed row from column 1. On a 200 column terminal a one-character change
 * cost 200 characters plus a style preamble, which is what kept the frame expensive enough that a periodic
 * full repaint looked attractive — and that periodic repaint is what shredded the screen whenever a bitmap was
 * present. Writing only the changed cell range removes the reason for a full repaint to exist.
 *
 * BITMAPS OUTLIVE CELL WRITES, SO THEY ARE RECONCILED, NOT DRAWN
 * --------------------------------------------------------------
 * Once Sixel has painted a rectangle, those pixels are on the screen and no cell write removes them: writing
 * characters there draws text ON TOP of the picture, and writing nothing leaves the picture showing through
 * whatever the model says is there. That asymmetry is the whole difficulty, and the shape below is dsh-tui's
 * (src/ink/sixel-graphics.ts there), because it is the only arrangement that survives being used:
 *
 *   - a placement is identified by WHAT IT DRAWS and WHERE. Two pictures with the same raster at different
 *     rows are different placements, and the old one must be erased;
 *   - an erase is ALWAYS paired with a draw of the thing that replaces it, in the same write. Erasing alone
 *     leaves a hole with no draw, and a frame that erases and then draws nothing is a black rectangle;
 *   - a placement that is unchanged in raster AND position costs zero bytes;
 *   - an erase uses Erase Character (`ESC [ n X`) over the placement's OWN COLUMNS, never the whole row. A
 *     full-row blank took out the scrollbar, the panel borders and the composer's frame.
 */

/**
 * How many rows of six pixels a Sixel sequence advances the cursor by.
 *
 * Windows Terminal leaves the cursor on the row of the LAST band — its `SixelParser::_updateTextCursor`
 * preserves the column and takes the final band — so the painter that addresses rows absolutely does not need
 * the number. It is needed by callers that write text after a picture relative to the cursor.
 *
 * @param {string} sequence
 * @returns {number}
 */
export function sixelCursorAdvance(sequence) {
  let advance = 0;
  for (let i = 0; i < sequence.length; i++) if (sequence.charCodeAt(i) === 0x2d) advance += 6; // '-'
  return advance;
}

/**
 * Erase a rectangle of a bitmap: real SPACE CHARACTERS over its cells, not just Erase Character.
 *
 * `ESC [ n X` asks the terminal to drop the characters in that span, and terminals disagree about whether that
 * also drops the PIXELS underneath — on Windows Terminal it does not reliably, so `ESC[nX` alone left the
 * previous formula visible through the new frame. Spaces are unambiguous: a cell written with a space has
 * nothing on it, and writing a cell is the one operation every terminal implements the same way.
 *
 * Erase Character still goes first. It is what clears a cell whose background must not be painted, and on the
 * terminals that DO drop pixels with it this is then a no-op.
 *
 * @param {{row:number, col:number, rows:number, cols:number}} rect
 * @returns {string}
 */
function eraseRect(rect) {
  if (!rect || rect.cols <= 0 || rect.rows <= 0) return '';
  const blanks = ' '.repeat(rect.cols);
  let out = '\x1b[0m';
  for (let r = 0; r < rect.rows; r++) {
    const y = rect.row + r;
    if (y < 0) continue;
    out += `\x1b[${y + 1};${rect.col + 1}H\x1b[${rect.cols}X` + blanks;
  }
  return out;
}


/**
 * A placement's identity: WHERE it is, WHAT SHAPE it claims, and WHAT IT DEPICTS.
 *
 * All three are needed, and each one's absence caused a visible bug:
 *   - the ROW, because scrolling moves a picture to a different row and a picture that is only re-addressed
 *     leaves its pixels behind at the old one;
 *   - the CELL BOX, because a crop shortens the picture and the erase has to know the new extent;
 *   - a hash of the PAYLOAD, because the same formula can be drawn at two different cuts — `skipTop` changes
 *     the pixels while the row and the box may stay the same, and without the hash the second one was never
 *     sent.
 *
 * A full string comparison would be correct too, but the payload is up to a kilobyte and this key is computed
 * per picture per frame; the hash keeps it cheap and keeps the key small enough to read in a log.
 *
 * @param {{row:number, col:number, rows:number, cols:number, seq:string, srcHash?:string}} img
 * @returns {string}
 */
export function placementKey(img) {
  const hash = img.srcHash
    || `${img.seq.length.toString(36)}${hashSeq(img.seq)}`;
  return `${img.row}:${img.col}:${img.rows}:${img.cols}\u0000${hash}`;
}

/**
 * A cheap, stable digest of a payload.
 *
 * FNV-1a over the characters: three operations per byte, no allocation, and collision odds that do not matter
 * for a handful of formulas compared every frame. It is not a security hash and must not be used as one.
 *
 * @param {string} s
 * @returns {string}
 */
function hashSeq(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}


/**
 * Reconcile this frame's placements against what the terminal is showing, and paint.
 *
 * @param {import('./screen.js').Screen|null} prev The frame the terminal is currently showing, or null when
 *   the terminal's contents are unknown.
 * @param {import('./screen.js').Screen} next The frame to show.
 * @param {Array<{row:number, col:number, rows:number, cols:number, seq:string}>} images Every placement this
 *   frame wants on screen. Whether one is actually DRAWN is decided here.
 * @param {object} [opts]
 * @param {string} [opts.before] Prefix written before any cell, for synchronized output.
 * @param {string} [opts.after] Suffix written after the last cell.
 * @param {string} [opts.cursor] Cursor placement written last.
 * @param {Map<string, boolean>} [opts.shown] What the terminal is believed to be showing, from the previous
 *   call. Mutated in place: entries whose placement this frame no longer wants are dropped, so the map cannot
 *   grow without bound.
 * @param {number} [opts.budget] Bytes of picture payload this write may carry.
 * @param {number} [opts.maxImages] Placements this write may carry.
 * @returns {string}
 */
export function diffScreens(prev, next, images = [], opts = {}) {
  const before = opts.before || '';
  const after = opts.after || '';
  const cursor = opts.cursor || '';
  const shown = opts.shown;
  const budget = opts.budget === undefined ? Infinity : opts.budget;
  const maxImages = opts.maxImages === undefined ? Infinity : opts.maxImages;
  // The terminal's cell height, in pixels: a crop has to convert CELL ROWS to six-pixel BANDS, and it cannot
  // do that without knowing how tall a row is.
  const cellHeight = opts.cellHeight > 0 ? opts.cellHeight : 20;

  // ---- what the terminal has, and what it should have ---------------------------
  // `has` is the record of what was painted last time. It survives because the ERASE is computed from it: a
  // rectangle the frame no longer wants has to be blanked, and only this record says where it was.
  const has = prev && shown ? shown : new Map();
  const want = new Map();
  let spent = 0;
  for (const img of images) {
    if (img.row + img.rows <= 0 || img.row >= next.height) continue;   // scrolled out of the window
    const key = placementKey(img);
    if (img.draw === false) continue;      // the caller refused it (no protocol, no cell size, too large)
    if (want.size >= maxImages) continue;
    if (img.seq.length > budget - spent) continue;        // over this frame's budget
    spent += img.seq.length;
    want.set(key, img);
  }

  // WHICH OF THOSE ACTUALLY HAVE TO BE DRAWN AGAIN.
  //
  // A picture whose placement key is unchanged — same row, same cell box, same payload hash — is already on
  // screen exactly as this frame wants it, so sending it again would cost bytes and buy nothing. The key holds
  // the row precisely so that SCROLLING always misses it: a formula that moved is a different placement, and
  // the terminal does not carry sixel pixels across rows.
  //
  // The old version of this check was wrong twice: it left the row out of the key, so a formula that had
  // scrolled was considered "already there" and was never redrawn into its new row; and it was consulted
  // before the erase, so the rectangle the picture had vacated was never blanked either. Now the key carries
  // the position and the hash, and the erase below is computed from `has` regardless of what is skipped.
  const drawNeeded = new Set();
  for (const [key, img] of want) if (!has.has(key)) drawNeeded.add(key);

  // ---- erase what is going away ------------------------------------------------
  // A placement leaves for two reasons: the content changed, or IT MOVED. Both need the old pixels gone, and
  // both need them gone in the same write as the replacement — an erase with no draw is a blank rectangle,
  // and that rectangle is what covered the transcript, the scrollbar and the composer.
  //
  // THE ERASE ALSO CLEARS THE RECORD. Emitting the blank is only half of it: `prev` is the frame the NEXT
  // paint compares against, and it still says those cells held the old text. The next diff then finds "no
  // change" and writes nothing, so the old glyphs stay on screen *under* the new ones — the overlap. dsh-tui
  // does the same thing (src/ink/sixel-graphics.ts, `clearRegion(baseline, …)` over every erased rect) and
  // for the same reason.
  let erase = '';
  for (const [key, entry] of has) {
    if (want.has(key)) continue;   // still wanted, exactly where it is
    erase += eraseRect({ row: entry.row, col: entry.col, cols: entry.cols, rows: entry.rows });
    if (prev && typeof prev.clear === 'function') {
      const from = Math.min(prev.width, Math.max(0, entry.col || 0));
      const width = Math.max(0, Math.min(prev.width - from, (entry.cols || 0) + 2));
      for (let r = 0; r < (entry.rows || 0); r++) {
        const y = (entry.row || 0) + r;
        if (y < 0 || y >= prev.height) continue;
        if (width > 0) prev.clear(from, y, width, 1, 0);
      }
    }
  }
  if (shown) {
    shown.clear();
    for (const [key, img] of want) shown.set(key, img);
  }

  const covered = new Set();
  for (const img of want.values()) {
    for (let r = 0; r < img.rows; r++) covered.add(img.row + r);
  }
  const changes = [];
  next.diffRows(prev, (from, y, to) => {
    if (covered.has(y)) return;
    changes.push({ y, from, to });
  });
  if (prev && Array.isArray(prev.imageRows)) {
    for (const row of prev.imageRows) {
      if (covered.has(row)) continue;
      if (row < 0 || row >= next.height) continue;
      if (!changes.some((c) => c.y === row)) changes.push({ y: row, from: 0, to: next.width });
    }
  }

  const events = changes.map((c) => ({ ...c, kind: 'text' }));
  for (const img of want.values()) events.push({ y: img.row, kind: 'image', img });
  events.sort((a, b) => a.y - b.y);

  // AUTO-WRAP OFF FOR THE WHOLE FRAME.
  //
  // A sixel draw leaves the cursor somewhere inside the picture. If that lands on the last column, the
  // terminal's auto-wrap pushes a line — and once the screen is full, that scrolls it. Every row here is
  // placed by absolute address, so wrapping buys nothing and costs the one thing that must not move: the
  // screen. Turning it off for the frame is what makes re-sending every picture on every frame safe.
  const WRAP_OFF = '\x1b[?7l';
  const WRAP_ON = '\x1b[?7h';
  let out = before + WRAP_OFF + erase;
  const sizeChanged = !prev || prev.width !== next.width || prev.height !== next.height;

  if (sizeChanged) {
    // The terminal's contents are unknown or the wrong shape: paint every row, in order, then every picture
    // by absolute address at the END — the same shape as the diff path, for the same reason.
    //
    // A picture whose FIRST VISIBLE row is 0 can carry a NEGATIVE `row`: it is cropped, not absent. Looking
    // pictures up by `img.row` therefore missed it whenever it straddled the top of the window, which is most
    // of the time a formula is being scrolled past — it simply never got drawn on the first frame.
    //
    // A row a picture covers is written only up to the picture's RIGHT EDGE: the rest of that row is the
    // interface's, and the scrollbar lives in its last column.
    const rightEdge = new Map();
    for (const img of want.values()) {
      const from = Math.max(0, img.row);
      const to = Math.min(img.row + img.rows, next.height);
      const right = Math.min(next.width, (img.col || 0) + 1 + Math.max(0, img.cols));
      for (let y = from; y < to; y++) rightEdge.set(y, Math.min(rightEdge.get(y) ?? next.width, right));
    }
    for (let y = 0; y < next.height; y++) {
      const right = rightEdge.get(y) ?? next.width;
      out += `\x1b[${y + 1};1H` + rowText(next, y, 0, right) + '\x1b[0m';
    }
    for (const img of want.values()) out += placeImage(img, next.height, cellHeight);
    return out + WRAP_ON + after + cursor;
  }

  // Text rows and pictures in screen order, so a later row never lands on top of an earlier picture.
  //
  // WHETHER A PICTURE IS REDRAWN IS DECIDED BY WHAT THE TEXT DID, not by whether the picture itself changed.
  // That is dsh-tui's rule, and this is its code (src/ink/sixel-graphics.ts there, `paint`):
  //
  //     if (!this.dirty && !this.repaint.has(node)) {
  //       if (damage === undefined) damage = this.textDamage(diff)
  //       if (damage !== null && !damage.some(rect => overlaps(rect, next))) continue
  //     }
  //
  // The reason is what a Sixel does to the terminal: each draw moves the screen, so a redraw that was not
  // required is a visible jump. A picture therefore goes back on screen only when the text around it moved —
  // when a changed row overlaps the picture's own rectangle. An idle tick, a status-line number, a spinner:
  // none of them touch a formula's rows, and none of them may cost a draw.
  const imageRows = new Set();
  // Pictures are COLLECTED here and drawn at the very END of the frame. A sixel sequence interleaved with
  // cursor moves and text is the fragile arrangement: any byte the terminal misreads, any address it takes
  // relatively, and everything after the picture lands somewhere else. Writing all the text first, then
  // every picture by absolute address, means a picture can only ever affect its own rectangle.
  const pending = [];
  for (const ev of events) {
    if (ev.kind === 'image') {
      const span = placementRows(ev.img, next.height);
      const redraw = drawNeeded.has(placementKey(ev.img));
      // THE TEXT IS REWRITTEN ONLY WHEN THE PICTURE IS REWRITTEN — otherwise the rewrite ERASES it.
      //
      // The rows a picture owns are blank in the cell model, so writing their text means writing spaces, and
      // a space over a cell destroys the pixels on it. Doing that on a frame whose picture was SKIPPED (the
      // cache hit) blanked a picture that was still on screen: it vanished for a frame, came back on the next
      // one, went away again — the flicker. The two decisions are one decision: either this rectangle is
      // repainted end to end, or nothing touches it.
      //
      // AND ONLY UP TO THE LAST COLUMN, BUT SKIPPING THE SCROLLBAR'S.
      //
      // The row belongs to the interface, not to the picture: everything to the right of the formula is
      // ordinary text and has to be rewritten, or the previous frame's characters stay there — a horizontal
      // rule left over from a code fence hanging off the end of every formula. Writing the FULL row instead
      // erased the scrollbar, whose track sits in the last column of exactly these rows, so it stops one short.
      if (redraw) {
        const right = Math.max(1, next.width - 1);
        for (let y = span.from; y < span.to; y++) {
          out += `\x1b[${y + 1};1H` + rowText(next, y, 0, right) + '\x1b[0m';
        }
        pending.push(ev.img);
      }
      // A row the picture owns is never written as ordinary text, drawn this frame or not: the characters
      // there belong to the picture, and the model has them blank anyway.
      for (let y = span.from; y < span.to; y++) imageRows.add(y);
      continue;
    }
    if (imageRows.has(ev.y)) continue;
    out += `\x1b[${ev.y + 1};${ev.from + 1}H` + rowText(next, ev.y, ev.from, ev.to) + '\x1b[0m';
  }

  // EVERY PICTURE LAST, each at its own absolute address.
  for (const img of pending) out += placeImage(img, next.height, cellHeight);

  return out + WRAP_ON + after + cursor;
}



/**
 * Rows and bands are DIFFERENT UNITS, and confusing them is what made a formula jump into place mid-scroll.
 *
 * A placement is measured in terminal CELL ROWS (`img.rows`). The sixel payload it carries is measured in
 * BANDS of six PIXEL rows. With a 20-pixel cell one cell row is 3.3 bands, so dropping `hidden` bands to
 * account for `hidden` rows threw away a sixth of the picture that should have stayed: the image was drawn
 * from the wrong point in its own payload, and because the offset changed by whole rows as the user scrolled,
 * the formula appeared to slide in and out of existence.
 *
 * A crop can only land on a band boundary, so the drop is rounded DOWN to a whole band. Dropping less than a
 * full cell leaves at most one band of pixels above the window — invisible — and never removes pixels that
 * belong on screen.
 *
 * @param {number} hiddenRows Cell rows of the placement that sit above the window.
 * @param {number} cellHeight The terminal's cell height in pixels.
 * @returns {number} Bands to drop from the top of the payload.
 */
function bandsToDrop(hiddenRows, cellHeight) {
  if (hiddenRows <= 0) return 0;
  const height = cellHeight > 0 ? cellHeight : 20;
  return Math.floor((hiddenRows * height) / 6);
}

/**
 * Drop whole bands from the top of a sixel payload, keeping the DCS header and the terminator.
 *
 * THE HEADER IS PART OF THE FIRST SEGMENT. A payload is `ESC P ... q "..." #...` followed by one segment per
 * band separated by `-`, so slicing the split array without re-attaching the first element throws away the
 * DCS introducer, the raster attributes and the palette — and the terminal then has no idea what the bytes
 * are and reads them as text.
 *
 * @param {string} seq The full sequence.
 * @param {number} drop Bands to drop from the top.
 * @returns {string} The cropped sequence, or '' when nothing would remain.
 */
function cropBands(seq, drop) {
  if (drop <= 0) return seq;
  const terminator = seq.endsWith('\x1b\\') ? '\x1b\\' : '';
  const body = terminator ? seq.slice(0, -terminator.length) : seq;
  const parts = body.split('-');
  if (parts.length <= 1) return '';
  // `parts[0]` carries the header AND the first band. Splitting the header off it lets both be handled
  // correctly: the header is always kept, the first band is droppable like every other one.
  const bandAt = parts[0].search(/#\d/);
  if (bandAt < 0) return '';
  const head = parts[0].slice(0, bandAt);
  const bands = [parts[0].slice(bandAt), ...parts.slice(1)];
  if (drop >= bands.length) return '';
  return head + bands.slice(drop).join('-') + terminator;
}

function placeImage(img, height, cellHeight) {
  const { from: top, to: bottom } = placementRows(img, height);
  if (bottom <= top) return '';
  const cellH = cellHeight > 0 ? cellHeight : 20;
  const hiddenRows = top - img.row;             // cell rows of the picture clipped away at the TOP

  // CROP THE PIXELS, NOT THE PAYLOAD — AND CROP BOTH EDGES.
  //
  // A sixel payload can only be cut on a six-pixel band boundary, and a cell is 20 pixels, so cropping the
  // encoded bytes always leaves 0..5 pixels of the picture above the window — up to a quarter of a cell. That
  // leftover is the slide: the formula shifts as the view scrolls and snaps back when the leftover happens to
  // be zero, which reads as "it only appears at certain scroll positions".
  //
  // The BOTTOM edge matters just as much. The transcript panel ends where the composer begins, and a picture
  // clipped to a single visible row still carried its full payload: the remaining rows were drawn OVER the
  // composer. Only the top was ever cut, so the bottom of every formula at the panel's edge spilled out.
  const visibleRows = bottom - top;
  if (visibleRows < img.rows && img.source) {
    const regenerated = regenerate(img.source, hiddenRows * cellH, img.cols, visibleRows * cellH);
    if (regenerated) {
      return `\x1b[?80l\x1b[${top + 1};${(img.col || 0) + 1}H\x1b[0m${regenerated}\x1b[?80h`
        + `\x1b[${top + 1};${(img.col || 0) + 1}H`;
    }
  }

  let seq = img.seq;
  if (hiddenRows > 0) seq = cropBands(img.seq, bandsToDrop(hiddenRows, cellH));
  // A band crop cannot express a bottom edge either, so the tail bands are dropped by the same conversion.
  const hiddenBelow = (img.row + img.rows) - bottom;
  if (hiddenBelow > 0) {
    const drop = bandsToDrop(hiddenBelow, cellH);
    const parts = seq.split('-');
    if (drop > 0 && parts.length > drop) seq = parts.slice(0, parts.length - drop).join('-') + (seq.endsWith('\x1b\\') ? '\x1b\\' : '');
  }
  if (!seq) return '';

  // A BITMAP STARTS WHERE THE TEXT DOES: every transcript row opens with a one-column pad, so the picture
  // goes one column in, where its own text would have started.
  //
  // THE CURSOR IS RE-ANCHORED AFTER THE DRAW. A Sixel leaves the cursor inside the picture — on Windows
  // Terminal it is the last band's row at the drawing column (`SixelParser::_updateTextCursor`), other
  // terminals differ — and every byte written after it is positioned relative to that. Re-anchoring costs
  // nine bytes and means nothing downstream has to know where a Sixel left the cursor.
  return `\x1b[?80l\x1b[${top + 1};${(img.col || 0) + 1}H\x1b[0m${seq}\x1b[?80h`
    + `\x1b[${top + 1};${(img.col || 0) + 1}H`;
}


/**
 * Re-render a formula cut at `skipTop` pixel rows, as a terminal sequence.
 *
 * A HOOK, so this module does not have to know about TeX. A placement carries the source it was made from,
 * and whoever knows how to turn that source into pixels again plugs the function in here. Without one the
 * payload is cropped on a band boundary instead, which is approximate but never wrong in position.
 *
 * @type {((source: string, skipTop: number, maxColumns: number, maxHeight?: number) => string|null)|null}
 */
let regenerateHook = null;

/** @param {((source: string, skipTop: number, maxColumns: number, maxHeight?: number) => string|null)|null} fn */
export function setImageRegenerator(fn) {
  regenerateHook = fn;
}

/**
 * Regenerate a payload cropped at both edges, or null when no renderer is installed.
 *
 * `skipTop` and `maxHeight` are PIXEL rows: a picture clipped by the window has to be re-typeset from its
 * first visible pixel and cut again at its last one, because a band crop can express neither.
 *
 * @param {string} source
 * @param {number} skipTop Pixels to remove from the top.
 * @param {number} maxColumns Columns the result may occupy.
 * @param {number} [maxHeight] Pixels the result may occupy, or undefined for no bottom limit.
 * @returns {string|null}
 */
function regenerate(source, skipTop, maxColumns, maxHeight) {
  if (typeof regenerateHook !== 'function') return null;
  try {
    return regenerateHook(source, skipTop, maxColumns, maxHeight) || null;
  } catch {
    return null;
  }
}



/**
 * The first and last screen row a placement may touch, clipped to both the screen and its own panel.
 *
 * `clipTop`/`clipBottom` come from the composer: a formula belongs to the transcript, which ends where the
 * input box begins. Clipping to the screen alone let a picture's last rows spill into the composer — the
 * formula slid down into the input box before it left the view.
 *
 * @param {{row:number, rows:number, clipTop?:number, clipBottom?:number}} img
 * @param {number} height Rows the screen has.
 * @returns {{from:number, to:number}} Half-open row range in SCREEN coordinates.
 */
export function placementRows(img, height) {
  const limitTop = img.clipTop != null ? Math.max(0, img.clipTop) : 0;
  const limitBottom = img.clipBottom != null ? Math.min(height, img.clipBottom) : height;
  const top = Math.max(limitTop, img.row);
  const bottom = Math.min(img.row + img.rows, limitBottom);
  return { from: top, to: Math.max(top, bottom) };
}




/**
 * One row's cells from `from` up to `to`, with the style changes inside that range.
 *
 * A style is represented as the accumulated SGR string that establishes it; the writer resets and re-applies
 * rather than computing a minimal difference, because a wrong minimal difference is a visible bug and a reset
 * costs six bytes.
 */
function rowText(screen, y, from, to) {
  let out = '';
  let styleId = -1;
  for (let x = from; x < to; x++) {
    if (screen.isSpacer(x, y)) continue;
    const cell = screen.at(x, y);
    if (cell.styleId !== styleId) {
      out += '\x1b[0m' + screen.stylePool.get(cell.styleId);
      styleId = cell.styleId;
    }
    out += cell.ch;
  }
  return out;
}

export { eraseRect, eraseRegion as eraseRegionRow };

/** Kept for callers that erase a single row span. */
function eraseRegion(x, y, width) {
  if (width <= 0) return '';
  return `\x1b[${y + 1};${x + 1}H\x1b[${width}X`;
}
