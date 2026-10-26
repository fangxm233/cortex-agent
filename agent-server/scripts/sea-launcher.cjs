const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { getRawAsset } = require('node:sea');
const { ensureCache } = require('./sea-cache.cjs');

const parent = process.env.CORTEX_SEA_CACHE || path.join(os.homedir(), '.cache', 'cortex-sea');
const root = ensureCache(parent, SEA_BUILD_ID, () => Buffer.from(getRawAsset('payload')));
process.env.CORTEX_SEA_ROOT = root;
process.env.CORTEX_SEA_EXEC = process.execPath;
createRequire(path.join(root, 'package.json'))('./sea-runtime.cjs');
