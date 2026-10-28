const fs = require('node:fs');
const path = require('node:path');
const { zstdDecompressSync } = require('node:zlib');

function unpack(payload, directory) {
  let offset = 4 + payload.readUInt32LE(0);
  const records = JSON.parse(payload.subarray(4, offset));
  for (const [name, mode, length] of records) {
    const file = path.resolve(directory, name);
    if (!file.startsWith(directory + path.sep)) throw new Error(`Invalid SEA asset: ${name}`);
    if (offset + length > payload.length) throw new Error(`Truncated SEA asset: ${name}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, payload.subarray(offset, offset + length), { mode });
    offset += length;
  }
}

function ensureCache(parent, id, payload) {
  parent = path.resolve(parent);
  const target = path.join(parent, id);
  if (fs.existsSync(path.join(target, '.complete'))) return target;
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stage = fs.mkdtempSync(path.join(parent, `${id}.tmp-`));
  try {
    unpack(zstdDecompressSync(payload()), stage);
    fs.writeFileSync(path.join(stage, '.complete'), id);
    try { fs.renameSync(stage, target); }
    catch (error) { if (!fs.existsSync(path.join(target, '.complete'))) throw error; }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  return target;
}

module.exports = { ensureCache };
