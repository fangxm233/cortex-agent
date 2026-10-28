const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { zstdCompressSync } = require('node:zlib');
const { ensureCache } = require('./sea-cache.cjs');

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sea-cache-test-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return parent;
}
function archive(files) {
  const buffers = files.map(file => Buffer.from(file[2], 'base64'));
  const header = Buffer.from(JSON.stringify(files.map(([name, mode], i) => [name, mode, buffers[i].length])));
  const length = Buffer.alloc(4); length.writeUInt32LE(header.length);
  return zstdCompressSync(Buffer.concat([length, header, ...buffers]));
}

test('extract atomically, preserve modes, and reuse only a complete cache', t => {
  const parent = fixture(t);
  const target = ensureCache(parent, 'v1', () => archive([['x/y', 0o755, Buffer.from('ok').toString('base64')]]));
  assert.equal(fs.readFileSync(path.join(target, 'x/y'), 'utf8'), 'ok');
  assert.equal(fs.statSync(path.join(target, 'x/y')).mode & 0o777, 0o755);
  assert.equal(ensureCache(parent, 'v1', () => { throw new Error('must not unpack twice'); }), target);
  assert.deepEqual(fs.readdirSync(parent), ['v1']);
});

test('failure leaves no trusted partial cache and retry works', t => {
  const parent = fixture(t);
  assert.throws(() => ensureCache(parent, 'v1', () => Buffer.from('corrupt')));
  assert.deepEqual(fs.readdirSync(parent), []);
  assert(fs.existsSync(path.join(ensureCache(parent, 'v1', () => archive([])), '.complete')));
});

test('reject paths outside the extraction directory', t => {
  const parent = fixture(t);
  assert.throws(() => ensureCache(parent, 'v1', () => archive([['../escape', 0o644, '']])), /Invalid SEA asset/);
  assert.deepEqual(fs.readdirSync(parent), []);
});

test('relative cache roots are normalized before extraction and reuse', t => {
  const parent = fixture(t);
  const target = ensureCache(path.relative(process.cwd(), parent), 'v1', () => archive([]));
  assert.equal(target, path.join(parent, 'v1'));
});
