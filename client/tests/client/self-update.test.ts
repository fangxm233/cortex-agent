// input:  synthetic update messages and temp install roots
// output: assertions on hash identity, install/swap and failure containment
// pos:    Covers the client self-update handler
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

// CORTEX_HOME must be set before the module (via paths.js) resolves DATA_DIR.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-self-update-'));
process.env.CORTEX_HOME = tempHome;

const {
  BUNDLE_FILES,
  CLIENT_INSTALL_DIR,
  hashBundleFiles,
  computeSelfBundleHash,
  handleUpdateMessage,
} = await import('../../src/self-update.js');

function makeFiles(tag: string): Array<{ name: string; data: string }> {
  return BUNDLE_FILES.map((name) => ({
    name,
    data: Buffer.from(`// ${name} ${tag}\n`).toString('base64'),
  }));
}

function hashOf(files: Array<{ name: string; data: string }>): string {
  const h = crypto.createHash('sha256');
  for (const name of BUNDLE_FILES) {
    h.update(Buffer.from(files.find((f) => f.name === name)!.data, 'base64'));
  }
  return h.digest('hex');
}

interface IoLog {
  results: Array<{ ok: boolean; error?: string }>;
  closed: boolean;
  respawned: string[];
  exited: number[];
}

function makeIo(): { io: Parameters<typeof handleUpdateMessage>[1]; log: IoLog } {
  const log: IoLog = { results: [], closed: false, respawned: [], exited: [] };
  return {
    io: {
      sendResult: (ok, error) => log.results.push({ ok, ...(error ? { error } : {}) }),
      closeWs: () => { log.closed = true; },
      respawn: (p) => log.respawned.push(p),
      exit: (c) => log.exited.push(c),
    },
    log,
  };
}

function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (cond()) { clearInterval(t); resolve(); }
      else if (Date.now() - start > ms) { clearInterval(t); reject(new Error('timeout')); }
    }, 10);
  });
}

describe('self-update', () => {
  beforeEach(() => {
    fs.rmSync(CLIENT_INSTALL_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    fs.rmSync(CLIENT_INSTALL_DIR, { recursive: true, force: true });
  });

  it('installs a valid update into current/ and respawns from it', async () => {
    const files = makeFiles('v1');
    const { io, log } = makeIo();
    handleUpdateMessage({ type: 'update', hash: hashOf(files), files }, io);
    await waitFor(() => log.exited.length > 0);

    assert.deepEqual(log.results, [{ ok: true }]);
    assert.equal(log.closed, true);
    assert.equal(log.respawned[0], path.join(CLIENT_INSTALL_DIR, 'current', 'client.mjs'));
    assert.equal(hashBundleFiles(path.join(CLIENT_INSTALL_DIR, 'current')), hashOf(files));
    assert.equal(fs.existsSync(path.join(CLIENT_INSTALL_DIR, 'next')), false);
  });

  it('rotates the running version into previous/', async () => {
    const v1 = makeFiles('v1');
    const first = makeIo();
    handleUpdateMessage({ type: 'update', hash: hashOf(v1), files: v1 }, first.io);
    await waitFor(() => first.log.exited.length > 0);

    const v2 = makeFiles('v2');
    const second = makeIo();
    handleUpdateMessage({ type: 'update', hash: hashOf(v2), files: v2 }, second.io);
    await waitFor(() => second.log.exited.length > 0);

    assert.equal(hashBundleFiles(path.join(CLIENT_INSTALL_DIR, 'current')), hashOf(v2));
    assert.equal(hashBundleFiles(path.join(CLIENT_INSTALL_DIR, 'previous')), hashOf(v1));
  });

  it('rejects a hash mismatch and leaves current untouched', async () => {
    const v1 = makeFiles('v1');
    const first = makeIo();
    handleUpdateMessage({ type: 'update', hash: hashOf(v1), files: v1 }, first.io);
    await waitFor(() => first.log.exited.length > 0);

    const bad = makeFiles('v2');
    const second = makeIo();
    handleUpdateMessage({ type: 'update', hash: 'deadbeef', files: bad }, second.io);

    assert.equal(second.log.results.length, 1);
    assert.equal(second.log.results[0].ok, false);
    assert.match(second.log.results[0].error!, /hash mismatch/);
    assert.equal(second.log.closed, false);
    assert.equal(second.log.exited.length, 0);
    assert.equal(hashBundleFiles(path.join(CLIENT_INSTALL_DIR, 'current')), hashOf(v1));
    assert.equal(fs.existsSync(path.join(CLIENT_INSTALL_DIR, 'next')), false);
  });

  it('rejects a message missing artifact files without touching disk', () => {
    const { io, log } = makeIo();
    handleUpdateMessage(
      { type: 'update', hash: 'abc', files: [{ name: 'client.mjs', data: 'aGk=' }] },
      io,
    );
    assert.equal(log.results[0].ok, false);
    assert.match(log.results[0].error!, /missing file/);
    assert.equal(fs.existsSync(CLIENT_INSTALL_DIR), false);
  });

  it('computeSelfBundleHash matches the artifact hash for a managed layout', () => {
    const dir = path.join(CLIENT_INSTALL_DIR, 'current');
    fs.mkdirSync(dir, { recursive: true });
    const files = makeFiles('vX');
    for (const f of files) {
      fs.writeFileSync(path.join(dir, f.name), Buffer.from(f.data, 'base64'));
    }
    assert.equal(computeSelfBundleHash(path.join(dir, 'client.mjs')), hashOf(files));
    // Unmanaged layout (entry without siblings) falls back to an entry- hash.
    const lone = path.join(tempHome, 'lone.js');
    fs.writeFileSync(lone, 'x');
    assert.match(computeSelfBundleHash(lone), /^entry-[0-9a-f]{64}$/);
  });
});
