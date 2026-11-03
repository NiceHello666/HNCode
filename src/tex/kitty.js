/**
 * RGBA → a Kitty graphics sequence.
 *
 * The Kitty protocol carries an image in two parts, and they are kept apart on purpose:
 *
 *   a=t   TRANSMIT. Uploads the pixels once and gives them an id. Nothing appears on screen.
 *   a=p   PLACE.   Puts an already-uploaded image at a cell, at a size in cells, croppable, with a z-index.
 *
 * That split is the whole reason a formula is cheap to scroll: the pixels are uploaded once and every frame
 * after that is a twenty-byte placement. Re-uploading on every frame would move bytes the terminal already has
 * and, on some terminals, redraw the picture mid-frame.
 *
 * The image is sent as RAW RGBA (`f=32`), not PNG: there is no image encoder in this project and none is
 * needed — `a=t,f=32` is a documented format, and `o=z` lets zlib shrink it. `q=2` keeps the terminal from
 * answering every chunk; `q=0` would make it answer each one.
 *
 * CHUNKING IS MANDATORY. A single APC cannot exceed a few kilobytes on most terminals, so the base64 is split
 * and every chunk but the last says `m=1` (more coming). A chunk that is split wrong, or a stream that loses
 * its `m` flag, leaves the terminal in the middle of an escape sequence.
 */

/** The APC introducer every Kitty graphics command starts with. */
const APC = '\u001b_G';
/** String terminator. */
const ST = '\u001b\\';
/**
 * Base64 characters per chunk. The protocol allows 4096 bytes of payload per chunk; 4096 base64 characters is
 * 3072 bytes of input, comfortably inside that.
 */
const CHUNK = 4096;
/** Behind text and panel backgrounds: a formula must never cover the interface drawn over it. */
const Z_INDEX = -0x80000000;

/** One Kitty graphics command: the control key=value list, then a `;`, then the payload. */
function command(control, payload = '') {
  return APC + control + (payload ? ';' + payload : '') + ST;
}

/**
 * Upload an RGBA raster under an image id.
 *
 * @param {number} id The image id. Must be stable for the same pixels so placements can reuse it.
 * @param {Uint8ClampedArray|Uint8Array} rgba Pixels, width*height*4, straight alpha.
 * @param {number} width
 * @param {number} height
 * @returns {string} The sequence, ready to write.
 */
export function kittyTransmit(id, rgba, width, height) {
  const w = Math.max(0, width | 0);
  const h = Math.max(0, height | 0);
  if (!w || !h) return '';
  const base64 = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength).toString('base64');
  const chunks = [];
  for (let at = 0; at < base64.length; at += CHUNK) chunks.push(base64.slice(at, at + CHUNK));
  if (chunks.length === 0) chunks.push('');
  return chunks.map((chunk, i) => {
    const more = i + 1 < chunks.length ? 1 : 0;
    // The first chunk carries the format, the size and the id; the rest carry only the continuation flag.
    const control = i === 0
      ? `a=t,t=d,f=32,s=${w},v=${h},i=${id},q=2,m=${more}`
      : `m=${more},q=2`;
    return command(control, chunk);
  }).join('');
}

/**
 * Place an uploaded image at a cell.
 *
 * @param {number} id Image id from `kittyTransmit`.
 * @param {number} placementId Distinguishes several placements of the same image.
 * @param {number} x Column, 0-based.
 * @param {number} y Row, 0-based.
 * @param {number} columns Width in cells.
 * @param {number} rows Height in cells.
 * @param {{x:number, y:number, width:number, height:number}} [source] Pixel rectangle of the raster to show.
 * @returns {string}
 */
export function kittyPlace(id, placementId, x, y, columns, rows, source) {
  const crop = source
    ? `,x=${Math.max(0, source.x | 0)},y=${Math.max(0, source.y | 0)},w=${Math.max(1, source.width | 0)},h=${Math.max(1, source.height | 0)}`
    : '';
  // `C=1` leaves the cursor where it is afterwards: a placement must not move it, or every byte after is
  // positioned relative to somewhere nobody expected.
  return `\x1b[${y + 1};${x + 1}H`
    + command(`a=p,i=${id},p=${placementId},c=${Math.max(1, columns | 0)},r=${Math.max(1, rows | 0)}${crop},z=${Z_INDEX},C=1,q=1`);
}

/**
 * Delete a placement, leaving the image data uploaded so it can be placed again.
 *
 * @param {number} id
 * @param {number} placementId
 * @returns {string}
 */
export function kittyDeletePlacement(id, placementId) {
  return command(`a=d,d=i,i=${id},p=${placementId},q=2`);
}

/**
 * Delete the image data itself, for a picture that will not be seen again.
 *
 * @param {number} id
 * @returns {string}
 */
export function kittyDeleteImage(id) {
  return command(`a=d,d=I,i=${id},q=2`);
}

/**
 * Whether a chunk of terminal input is a Kitty graphics reply rather than something to paint.
 *
 * The terminal answers with its own APC: `ESC _ G i=<id>,p=<placement>,... ESC \`. A reply nothing consumes
 * would be printed as text — the `Gi=31;OK` that shows up in the middle of the interface when a transmission
 * is acknowledged and no one is listening.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isKittyReply(text) {
  return typeof text === 'string' && /^\u001b_G[\s\S]*\u001b\\$/.test(text);
}

/**
 * Read the fields of a Kitty reply.
 *
 * A reply body is `G` followed by the id and optional placement, then `;` and the status:
 *
 *   Gi=31;OK
 *   Gi=7,p=2;ENOENT: image data not found
 *
 * The STATUS lives after the semicolon, at the end of the LAST field — taking it from the first field would
 * read `i=31` and call a failure a success.
 *
 * @param {string} text A string that satisfies `isKittyReply`.
 * @returns {{id:number|null, placement:number|null, ok:boolean, error:string}}
 */
export function parseKittyReply(text) {
  const body = String(text).slice(APC.length, -ST.length);
  // Everything after the LAST `;` is the status; everything before it is the key list.
  const semi = body.lastIndexOf(';');
  const keys = semi >= 0 ? body.slice(0, semi) : body;
  const status = (semi >= 0 ? body.slice(semi + 1) : '').trim();
  const fields = {};
  for (const part of keys.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  const id = fields.i !== undefined && fields.i !== '' ? Number(fields.i) : null;
  const placement = fields.p !== undefined && fields.p !== '' ? Number(fields.p) : null;
  return {
    id: Number.isFinite(id) ? id : null,
    placement: Number.isFinite(placement) ? placement : null,
    ok: status === '' || status.toUpperCase() === 'OK',
    error: status.toUpperCase() === 'OK' ? '' : status,
  };
}

/**
 * A stable image id for a raster.
 *
 * FNV-1a over the pixels, folded into the range the protocol reserves for images (1..0xFFFFFFFE). The same
 * formula drawn at the same size always uploads under the same id, so scrolling never re-transmits it.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @returns {number}
 */
export function kittyImageId(rgba, width, height) {
  let h = 0x811c9dc5;
  h = (h ^ (width & 0xff)) >>> 0;
  h = Math.imul(h, 0x01000193) >>> 0;
  h = (h ^ (height & 0xff)) >>> 0;
  h = Math.imul(h, 0x01000193) >>> 0;
  for (let i = 0; i < rgba.length; i += 4) {
    h = (h ^ rgba[i]) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
    h = (h ^ rgba[i + 3]) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // 1..0xFFFFFFFF, never 0 (which the protocol reserves for "no id").
  return (h >>> 0) || 1;
}

export { APC as KITTY_APC, ST as KITTY_ST };
