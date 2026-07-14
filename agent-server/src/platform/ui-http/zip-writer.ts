// input:  a list of { name, data } entries (in-memory files)
// output: createZip(entries) -> Buffer — a valid ZIP archive (DEFLATE, method 8) + crc32(buf)
// pos:    Dependency-free ZIP encoder for the frontend OTA bundle (platform/ui-http). The desktop
//         shell's Rust `zip` crate reads this, so the container stays classic: one local file header
//         per entry (sizes+CRC known up-front, no data descriptor / bit-3), a central directory, and
//         an EOCD. Output is deterministic (fixed DOS timestamp + entries sorted by name) so an
//         unchanged SPA always encodes to identical bytes. Uses only Node's built-in zlib — no deps,
//         matching the repo's minimal-dependency posture.
// >>> If I am updated, update CORTEX.md <<<

import * as zlib from 'node:zlib';

export interface ZipEntry {
  /** POSIX-style archive path, e.g. "assets/app.js". */
  name: string;
  /** File bytes. */
  data: Buffer;
}

const LFH_SIG = 0x04034b50; // local file header
const CDH_SIG = 0x02014b50; // central directory header
const EOCD_SIG = 0x06054b50; // end of central directory
const METHOD_DEFLATE = 8;
const VERSION_NEEDED = 20; // 2.0 — DEFLATE
/** Fixed DOS date (1980-01-01) + time (00:00:00) so identical content encodes to identical bytes. */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;

// ── CRC-32 (ISO-HDLC, the polynomial ZIP uses) ────────────────────────────────
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 of a buffer (returns an unsigned 32-bit value). */
export function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Encode entries into a ZIP archive Buffer. Entries are sorted by name and each is DEFLATE-compressed
 * (method 8) with its CRC-32 and sizes written up-front in the local header (no data descriptor).
 */
export function createZip(entries: ZipEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0; // running offset of the next local header within the archive

  for (const entry of sorted) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const compressed = zlib.deflateRawSync(entry.data);
    const uSize = entry.data.length;
    const cSize = compressed.length;

    // Local file header (30 bytes fixed) + name + compressed data.
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(LFH_SIG, 0);
    lfh.writeUInt16LE(VERSION_NEEDED, 4);
    lfh.writeUInt16LE(0, 6); // general-purpose flags (bit 3 off → sizes present here)
    lfh.writeUInt16LE(METHOD_DEFLATE, 8);
    lfh.writeUInt16LE(DOS_TIME, 10);
    lfh.writeUInt16LE(DOS_DATE, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(cSize, 18);
    lfh.writeUInt32LE(uSize, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28); // extra field length
    localParts.push(lfh, nameBuf, compressed);

    // Central directory header (46 bytes fixed) + name.
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(CDH_SIG, 0);
    cdh.writeUInt16LE(VERSION_NEEDED, 4); // version made by
    cdh.writeUInt16LE(VERSION_NEEDED, 6); // version needed
    cdh.writeUInt16LE(0, 8); // flags
    cdh.writeUInt16LE(METHOD_DEFLATE, 10);
    cdh.writeUInt16LE(DOS_TIME, 12);
    cdh.writeUInt16LE(DOS_DATE, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(cSize, 20);
    cdh.writeUInt32LE(uSize, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30); // extra field length
    cdh.writeUInt16LE(0, 32); // comment length
    cdh.writeUInt16LE(0, 34); // disk number start
    cdh.writeUInt16LE(0, 36); // internal attrs
    cdh.writeUInt32LE(0, 38); // external attrs
    cdh.writeUInt32LE(offset, 42); // relative offset of local header
    centralParts.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + compressed.length;
  }

  const localBlock = Buffer.concat(localParts);
  const centralBlock = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // this disk number
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(sorted.length, 8); // entries on this disk
  eocd.writeUInt16LE(sorted.length, 10); // total entries
  eocd.writeUInt32LE(centralBlock.length, 12); // central directory size
  eocd.writeUInt32LE(localBlock.length, 16); // central directory offset
  eocd.writeUInt16LE(0, 20); // archive comment length

  return Buffer.concat([localBlock, centralBlock, eocd]);
}
