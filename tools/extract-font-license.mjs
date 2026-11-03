/**
 * Write the licence that SHIPS WITH the bundled formula font.
 *
 * A font licence has to travel with the font, and it has to be the licence of the face that is actually in
 * the tree: a stale file from a previous face would state terms for glyphs this project no longer
 * distributes. So the text is read out of the font's own `name` table rather than copied by hand.
 *
 *   node tools/extract-font-license.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONT = path.join(HERE, '..', 'src', 'tex', 'fonts', 'STIX2Math.ttf');
const OUT = path.join(HERE, '..', 'src', 'tex', 'fonts', 'LICENSE.txt');

const buf = fs.readFileSync(FONT);

/** A table's offset and length, from the table directory. */
function table(tag) {
  const count = buf.readUInt16BE(4);
  for (let i = 0; i < count; i++) {
    const rec = 12 + i * 16;
    if (buf.toString('latin1', rec, rec + 4) === tag) {
      return { offset: buf.readUInt32BE(rec + 8), length: buf.readUInt32BE(rec + 12) };
    }
  }
  return null;
}

const name = table('name');
if (!name) throw new Error('font has no name table');
const count = buf.readUInt16BE(name.offset + 2);
const stringsAt = name.offset + buf.readUInt16BE(name.offset + 4);

const FIELDS = { 0: 'Copyright', 13: 'License', 14: 'License URL' };

/** One `name` record decoded: UTF-16BE for the Unicode platforms, single-byte otherwise. */
function read(id) {
  for (let i = 0; i < count; i++) {
    const rec = name.offset + 6 + i * 12;
    if (buf.readUInt16BE(rec + 6) !== id) continue;
    const platform = buf.readUInt16BE(rec);
    const length = buf.readUInt16BE(rec + 8);
    const at = stringsAt + buf.readUInt16BE(rec + 10);
    if (at + length > name.offset + name.length) continue;
    if (platform !== 3 && platform !== 0) return buf.toString('latin1', at, at + length);
    const bytes = Buffer.from(buf.subarray(at, at + length));
    bytes.swap16();                       // the table is big-endian, `utf16le` is not
    return bytes.toString('utf16le');
  }
  return '';
}

const body = [
  'The formula font in this directory is STIX Two Math (TrueType build, "STIX Two Math TT").',
  'It is distributed under the SIL Open Font License, Version 1.1.',
  '',
  ...Object.entries(FIELDS).flatMap(([id, label]) => [`${label}:`, read(Number(id)) || '(not stated in the font)', '']),
].join('\n');

fs.writeFileSync(OUT, body, 'utf8');
console.log('wrote', OUT, body.length, 'bytes');
