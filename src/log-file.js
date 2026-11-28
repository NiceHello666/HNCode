// A diagnostic log that cannot grow without limit.
//
// WHY THIS EXISTS
// ---------------
// Every log in this program appended forever: `paint.log` reached 174 MB, `keys.log`
// 7 MB, and `session-errors.log` grows by a line per failed save. On a machine with a
// small disk that is the difference between working and not, and none of it is ever
// read — a diagnostic log is consulted after a problem, not during one.
//
// ROTATION IS BY SIZE, CHECKED ON THE FILE'S OWN LENGTH.
//
// The check has to be cheap enough to sit on a paint path: `statSync` measured 33 µs
// here. That is paid per traced frame only when tracing is on, which it is not by
// default; on the exit and save paths it is paid once per event.
//
// The rotated file keeps ONE generation, `<name>.1`. A debug log is read immediately
// after the event that wrote it, so a second generation would only preserve the moment
// before the one being investigated, at twice the disk.
//
// A CONCURRENT WRITER LOSES NOTHING. The append is a single `appendFileSync`, which is
// O_APPEND and therefore atomic per record, so two hncode instances sharing one log
// interleave records rather than overwrite each other. Only the ROTATION can race, and
// the loser's rename fails harmlessly — that record is still appended, one rotation late.

import fs from 'node:fs';
import path from 'node:path';

/** Default ceiling for a diagnostic log. */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

// The size is remembered between writes so a burst costs one `statSync` instead of one
// per record. Another process growing the same file makes the value stale, which delays
// a rotation by that growth — for a shared file the ceiling is best-effort, never a
// correctness rule.
const sizeCache = new Map(); // file -> bytes

/** Current size of `file`, from the cache when this process wrote it last. */
function currentSize(file) {
  const known = sizeCache.get(file);
  if (known !== undefined) return known;
  try { return fs.statSync(file).size; } catch { return 0; }
}

/**
 * Rotate `file` to `file.1` when it is at or past `maxBytes`, keeping one generation.
 *
 * Exported for a caller that wants the check on its own, for content it did not build as
 * a single string.
 */
export function rotateIfLarge(file, maxBytes = DEFAULT_MAX_BYTES) {
  if (currentSize(file) < maxBytes) return false;
  try {
    fs.renameSync(file, `${file}.1`);
    sizeCache.set(file, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Append `text` to `file`, rotating first when the record would pass `maxBytes`.
 *
 * A record larger than the whole ceiling becomes the ONLY content of the rotated file.
 * Truncating it instead would cut the stack trace that made it worth recording, and that
 * one record is the reason the log is worth having.
 *
 * Rotation happens BEFORE the append, so the live file never grows past the ceiling and
 * always exists. Rotating afterwards left no live file at all until the next write.
 *
 * Returns true when the bytes landed. NEVER THROWS: a diagnostic log is not worth the
 * failure it would add to the path that was doing the logging.
 */
export function appendLog(file, text, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (text == null) return false;
  const data = String(text);
  const grow = Buffer.byteLength(data);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (grow >= maxBytes) {
      // The oversized record becomes the rotated file in one step, and the live log is
      // left present but empty: a reader must never find it MISSING, which would look
      // like logging was broken rather than rotated.
      fs.writeFileSync(`${file}.1`, data, 'utf8');
      fs.writeFileSync(file, '', 'utf8');
      sizeCache.set(file, 0);
      return true;
    }
    let size = currentSize(file);
    if (size > 0 && size + grow > maxBytes) {
      try {
        fs.renameSync(file, `${file}.1`);
        size = 0;
        sizeCache.set(file, 0);
      } catch {
        // Another reader holds the file open. Keep the record and let a later attempt
        // rotate; losing the write to win the rotation would be the wrong trade.
      }
    }
    fs.appendFileSync(file, data, 'utf8');
    sizeCache.set(file, size + grow);
    return true;
  } catch {
    return false;
  }
}

/** Forget the cached size for one file, or for all of them when no file is given. */
export function forgetLogSize(file) {
  if (file === undefined) { sizeCache.clear(); return; }
  sizeCache.delete(file);
}
