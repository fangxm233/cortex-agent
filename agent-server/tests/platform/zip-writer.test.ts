// input:  Node test runner + createZip/crc32 (dependency-free ZIP writer)
// output: unit tests — crc32 known-answer vectors, ZIP structural signatures (LFH/CDH/EOCD),
//         per-entry DEFLATE round-trip (inflateRaw == original), entry count, determinism,
//         empty-file and nested-path handling.
// pos:    Regression guard for the OTA bundle encoder (desktop frontend OTA, unit A). The Rust
//         `zip` crate is the real consumer; these tests pin the container invariants it relies on.
// >>> If I am updated, update the parent folder's CORTEX.md <<<

import test from 'node:test';
import assert from 'node:assert/strict';
import * as zlib from 'node:zlib';
import { createZip, crc32 } from '@platform/ui-http/zip-writer.js';

const LFH_SIG = 0x04034b50; // PK\x03\x04
const CDH_SIG = 0x02014b50; // PK\x01\x02
const EOCD_SIG = 0x06054b50; // PK\x05\x06

/** Minimal sequential ZIP reader used ONLY to validate our writer's output.
 *  Walks back-to-back local file headers until the central directory begins,
 *  inflating each entry and returning name → bytes. */
function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let off = 0;
  while (off + 4 <= buf.length && buf.readUInt32LE(off) === LFH_SIG) {
    const method = buf.readUInt16LE(off + 8);
    const compressedSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const nameStart = off + 30;
    const name = buf.toString('utf8', nameStart, nameStart + nameLen);
    const dataStart = nameStart + nameLen + extraLen;
    const comp = buf.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? zlib.inflateRawSync(comp) : Buffer.from(comp);
    out.set(name, data);
    off = dataStart + compressedSize;
  }
  return out;
}

test('crc32: known-answer vectors', () => {
  assert.equal(crc32(Buffer.from('')) >>> 0, 0x00000000);
  // Classic CRC-32/ISO-HDLC vector.
  assert.equal(
    crc32(Buffer.from('The quick brown fox jumps over the lazy dog')) >>> 0,
    0x414fa339,
  );
  assert.equal(crc32(Buffer.from('123456789')) >>> 0, 0xcbf43926);
});

test('createZip: begins with a local file header signature', () => {
  const zip = createZip([{ name: 'a.txt', data: Buffer.from('hello') }]);
  assert.equal(zip.readUInt32LE(0), LFH_SIG);
});

test('createZip: contains a central directory and an EOCD record', () => {
  const zip = createZip([{ name: 'a.txt', data: Buffer.from('hello') }]);
  // EOCD is the last 22 bytes (no archive comment).
  const eocdOff = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocdOff), EOCD_SIG);
  // Total entries (this disk + overall) must equal 1.
  assert.equal(zip.readUInt16LE(eocdOff + 8), 1);
  assert.equal(zip.readUInt16LE(eocdOff + 10), 1);
  // A central directory header must be present.
  let found = false;
  for (let i = 0; i + 4 <= zip.length; i++) {
    if (zip.readUInt32LE(i) === CDH_SIG) { found = true; break; }
  }
  assert.ok(found, 'central directory header signature must be present');
});

test('createZip: entries round-trip through DEFLATE (inflateRaw == original)', () => {
  const files = [
    { name: 'index.html', data: Buffer.from('<html>HELLO</html>') },
    { name: 'assets/app.js', data: Buffer.from('console.log(1);'.repeat(50)) },
    { name: 'empty.txt', data: Buffer.alloc(0) },
  ];
  const zip = createZip(files);
  const read = readZip(zip);
  assert.equal(read.size, files.length);
  for (const f of files) {
    const got = read.get(f.name);
    assert.ok(got, `entry ${f.name} must be present`);
    assert.deepEqual(got, f.data, `entry ${f.name} content must round-trip`);
  }
});

test('createZip: central directory records the correct CRC-32 per entry', () => {
  const data = Buffer.from('payload-bytes-for-crc');
  const zip = createZip([{ name: 'x.bin', data }]);
  // Find the CDH and read its CRC field (offset +16 within the record).
  let cdhOff = -1;
  for (let i = 0; i + 4 <= zip.length; i++) {
    if (zip.readUInt32LE(i) === CDH_SIG) { cdhOff = i; break; }
  }
  assert.ok(cdhOff >= 0);
  assert.equal(zip.readUInt32LE(cdhOff + 16) >>> 0, crc32(data) >>> 0);
});

test('createZip: is deterministic for identical input (stable bytes)', () => {
  const files = [
    { name: 'b.txt', data: Buffer.from('two') },
    { name: 'a.txt', data: Buffer.from('one') },
  ];
  const z1 = createZip(files);
  const z2 = createZip([...files]);
  assert.deepEqual(z1, z2, 'same input must yield byte-identical archives');
});

test('createZip: sorts entries by name so ordering of input does not matter', () => {
  const z1 = createZip([
    { name: 'a.txt', data: Buffer.from('1') },
    { name: 'b.txt', data: Buffer.from('2') },
  ]);
  const z2 = createZip([
    { name: 'b.txt', data: Buffer.from('2') },
    { name: 'a.txt', data: Buffer.from('1') },
  ]);
  assert.deepEqual(z1, z2, 'input ordering must not change the archive');
});
