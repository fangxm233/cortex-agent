const fs = require('node:fs');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');

function unpack(records, directory) {
  for (const [name, mode, data] of records) {
    const file = path.resolve(directory, name);
    if (!file.startsWith(directory + path.sep)) throw new Error(`Invalid SEA asset: ${name}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(data, 'base64'), { mode });
  }
}

function ensureCache(parent, id, payload) {
  const target = path.join(parent, id);
  if (fs.existsSync(path.join(target, '.complete'))) return target;
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stage = fs.mkdtempSync(path.join(parent, `${id}.tmp-`));
  try {
    unpack(JSON.parse(gunzipSync(payload())), stage);
    fs.writeFileSync(path.join(stage, '.complete'), id);
    try { fs.renameSync(stage, target); }
    catch (error) { if (!fs.existsSync(path.join(target, '.complete'))) throw error; }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  return target;
}

module.exports = { ensureCache };
