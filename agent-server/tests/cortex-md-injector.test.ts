// input:  Node test runner + CortexMDInjector + fs/path/os
// output: shared-cache/device/mtime dedup regression tests
// pos:    Verifies CORTEX.md injection dedup and persistence
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CortexMDInjector } from '../src/domain/memory/cortex-md-injector.js';

async function withCacheDir<T>(fn: (cacheDir: string) => Promise<T>): Promise<T> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cmd-inj-'));
  try { return await fn(dir); }
  finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
}

test('first call produces blocks, second call with same mtime produces none', async () => {
  await withCacheDir(async (cacheDir) => {
    const inj = new CortexMDInjector({ sessionId: 's1', cacheDir });
    const entry = { path: '/r/CORTEX.md', content: 'hello', mtimeMs: 1000 };
    const b1 = inj.buildBlocks('lab', [entry]);
    assert.strictEqual(b1.length, 1);
    assert.strictEqual(b1[0].type, 'text');
    assert.ok(b1[0].text.includes('lab:/r/CORTEX.md'));
    assert.ok(b1[0].text.includes('<system-reminder>'));
    assert.ok(b1[0].text.includes('hello'));
    const b2 = inj.buildBlocks('lab', [entry]);
    assert.strictEqual(b2.length, 0, 'duplicate call with same mtime suppressed');
  });
});

test('updated mtime triggers re-injection', async () => {
  await withCacheDir(async (cacheDir) => {
    const inj = new CortexMDInjector({ sessionId: 's1', cacheDir });
    inj.buildBlocks('lab', [{ path: '/r/CORTEX.md', content: 'v1', mtimeMs: 1000 }]);
    const b2 = inj.buildBlocks('lab', [{ path: '/r/CORTEX.md', content: 'v2', mtimeMs: 2000 }]);
    assert.strictEqual(b2.length, 1);
    assert.ok(b2[0].text.includes('v2'));
  });
});

test('cache persists across injector instances for same sessionId (resume)', async () => {
  await withCacheDir(async (cacheDir) => {
    const inj1 = new CortexMDInjector({ sessionId: 'abc', cacheDir });
    inj1.buildBlocks('lab', [{ path: '/r/CORTEX.md', content: 'x', mtimeMs: 1000 }]);
    const cacheFile = path.join(cacheDir, 'abc.json');
    assert.ok(fs.existsSync(cacheFile), 'cache file written to disk');
    const inj2 = new CortexMDInjector({ sessionId: 'abc', cacheDir });
    const b = inj2.buildBlocks('lab', [{ path: '/r/CORTEX.md', content: 'x', mtimeMs: 1000 }]);
    assert.strictEqual(b.length, 0, 'dedup survives process restart within same session');
  });
});

test('already-constructed injectors reload shared cache before each update', async () => {
  await withCacheDir(async (cacheDir) => {
    const inj1 = new CortexMDInjector({ sessionId: 'abc', cacheDir });
    const inj2 = new CortexMDInjector({ sessionId: 'abc', cacheDir });
    const entry = { path: '/r/CORTEX.md', content: 'x', mtimeMs: 1000 };

    assert.strictEqual(inj1.buildBlocks('lab', [entry]).length, 1);
    assert.strictEqual(
      inj2.buildBlocks('lab', [entry]).length,
      0,
      'a long-lived injector must observe another process\'s cache write',
    );
  });
});

test('entry deviceId unifies aliases for the same physical device', async () => {
  await withCacheDir(async (cacheDir) => {
    const inj = new CortexMDInjector({ sessionId: 'abc', cacheDir });
    const entry = {
      path: '/r/CORTEX.md',
      content: 'x',
      mtimeMs: 1000,
      deviceId: 'physical-host',
    };

    assert.strictEqual(inj.buildBlocks('configured-alias-a', [entry]).length, 1);
    assert.strictEqual(
      inj.buildBlocks('configured-alias-b', [entry]).length,
      0,
      'cache identity must use the physical host rather than the configured alias',
    );
  });
});

test('different sessionIds have independent caches', async () => {
  await withCacheDir(async (cacheDir) => {
    const injA = new CortexMDInjector({ sessionId: 'sA', cacheDir });
    injA.buildBlocks('lab', [{ path: '/r/CORTEX.md', content: 'x', mtimeMs: 1000 }]);
    const injB = new CortexMDInjector({ sessionId: 'sB', cacheDir });
    const b = injB.buildBlocks('lab', [{ path: '/r/CORTEX.md', content: 'x', mtimeMs: 1000 }]);
    assert.strictEqual(b.length, 1, 'new session must see CORTEX.md even if another session already saw it');
    assert.ok(fs.existsSync(path.join(cacheDir, 'sA.json')));
    assert.ok(fs.existsSync(path.join(cacheDir, 'sB.json')));
  });
});

test('missing sessionId (and no env var) → in-memory only, no file written', async () => {
  await withCacheDir(async (cacheDir) => {
    const prev = process.env.CORTEX_SESSION_ID;
    delete process.env.CORTEX_SESSION_ID;
    try {
      const inj = new CortexMDInjector({ cacheDir });
      inj.buildBlocks('lab', [{ path: '/r/CORTEX.md', content: 'x', mtimeMs: 1 }]);
      const files = await fs.promises.readdir(cacheDir);
      assert.deepStrictEqual(files, [], 'no cache file created without sessionId');
    } finally {
      if (prev !== undefined) process.env.CORTEX_SESSION_ID = prev;
    }
  });
});

test('invalid sessionId (contains /) → in-memory only', async () => {
  await withCacheDir(async (cacheDir) => {
    const inj = new CortexMDInjector({ sessionId: '../evil', cacheDir });
    inj.buildBlocks('lab', [{ path: '/r/CORTEX.md', content: 'x', mtimeMs: 1 }]);
    const files = await fs.promises.readdir(cacheDir);
    assert.deepStrictEqual(files, [], 'path-injection sessionId rejected');
  });
});

test('env var CORTEX_SESSION_ID is used when sessionId option is not provided', async () => {
  await withCacheDir(async (cacheDir) => {
    const prev = process.env.CORTEX_SESSION_ID;
    process.env.CORTEX_SESSION_ID = 'envsess';
    try {
      const inj = new CortexMDInjector({ cacheDir });
      inj.buildBlocks('lab', [{ path: '/r/CORTEX.md', content: 'x', mtimeMs: 1 }]);
      assert.ok(fs.existsSync(path.join(cacheDir, 'envsess.json')));
    } finally {
      if (prev === undefined) delete process.env.CORTEX_SESSION_ID;
      else process.env.CORTEX_SESSION_ID = prev;
    }
  });
});

test('empty entries array returns empty blocks', async () => {
  await withCacheDir(async (cacheDir) => {
    const inj = new CortexMDInjector({ sessionId: 's1', cacheDir });
    assert.strictEqual(inj.buildBlocks('lab', []).length, 0);
  });
});

test('corrupt cache file falls back to empty cache', async () => {
  await withCacheDir(async (cacheDir) => {
    await fs.promises.writeFile(path.join(cacheDir, 's1.json'), 'not json at all');
    const inj = new CortexMDInjector({ sessionId: 's1', cacheDir });
    const b = inj.buildBlocks('lab', [{ path: '/r/CORTEX.md', content: 'x', mtimeMs: 1 }]);
    assert.strictEqual(b.length, 1, 'corrupt cache does not block injection');
  });
});

test('multiple entries with mixed seen/unseen state — only unseen injected', async () => {
  await withCacheDir(async (cacheDir) => {
    const inj = new CortexMDInjector({ sessionId: 's1', cacheDir });
    inj.buildBlocks('lab', [{ path: '/a/CORTEX.md', content: 'a', mtimeMs: 1 }]);
    const b = inj.buildBlocks('lab', [
      { path: '/a/CORTEX.md', content: 'a', mtimeMs: 1 },    // dedup
      { path: '/b/CORTEX.md', content: 'b', mtimeMs: 2 },    // new
    ]);
    assert.strictEqual(b.length, 1);
    assert.ok(b[0].text.includes('/b/CORTEX.md'));
  });
});

test('atomic write leaves no .tmp files behind after normal writes', async () => {
  await withCacheDir(async (cacheDir) => {
    const inj = new CortexMDInjector({ sessionId: 's1', cacheDir });
    inj.buildBlocks('lab', [{ path: '/r/CORTEX.md', content: 'x', mtimeMs: 1 }]);
    inj.buildBlocks('lab', [{ path: '/r/CORTEX.md', content: 'x', mtimeMs: 2 }]);
    const files = await fs.promises.readdir(cacheDir);
    assert.ok(files.includes('s1.json'));
    assert.ok(!files.some(f => f.endsWith('.tmp')), `no stray tmp file, got ${files.join(',')}`);
  });
});

test('stale session cache files are removed on startup (TTL)', async () => {
  await withCacheDir(async (cacheDir) => {
    const stale = path.join(cacheDir, 'old.json');
    await fs.promises.writeFile(stale, '{}');
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await fs.promises.utimes(stale, eightDaysAgo / 1000, eightDaysAgo / 1000);

    const fresh = path.join(cacheDir, 'fresh.json');
    await fs.promises.writeFile(fresh, '{}');

    new CortexMDInjector({ sessionId: 'new', cacheDir });
    assert.ok(!fs.existsSync(stale), 'stale cache removed');
    assert.ok(fs.existsSync(fresh), 'fresh cache preserved');
  });
});

test('legacy global cache file is removed on startup (migration)', async () => {
  // We cannot safely touch /tmp/cortex-mcp-claudemd-cache.json in a shared test
  // environment without risking interference with a live MCP server. So we only
  // exercise the path when the legacy file does not exist — the implementation
  // passes `force: true` and must not throw.
  await withCacheDir(async (cacheDir) => {
    assert.doesNotThrow(() => new CortexMDInjector({ sessionId: 's1', cacheDir }));
  });
});

test('explicit cacheFile override bypasses sessionId resolution', async () => {
  await withCacheDir(async (cacheDir) => {
    const explicit = path.join(cacheDir, 'explicit.json');
    const inj = new CortexMDInjector({ cacheFile: explicit });
    inj.buildBlocks('lab', [{ path: '/r/CORTEX.md', content: 'x', mtimeMs: 1 }]);
    assert.ok(fs.existsSync(explicit));
  });
});

test('explicit cacheFile=null disables persistence', async () => {
  await withCacheDir(async (cacheDir) => {
    const inj = new CortexMDInjector({ cacheFile: null, cacheDir });
    inj.buildBlocks('lab', [{ path: '/r/CORTEX.md', content: 'x', mtimeMs: 1 }]);
    const files = await fs.promises.readdir(cacheDir);
    assert.deepStrictEqual(files, []);
  });
});

test('markOnlyPaths: entry updates cache but emits no block', async () => {
  await withCacheDir(async (cacheDir) => {
    const inj = new CortexMDInjector({ sessionId: 's1', cacheDir });
    const entry = { path: '/r/CORTEX.md', content: 'x', mtimeMs: 1000 };
    const b1 = inj.buildBlocks('lab', [entry], new Set(['/r/CORTEX.md']));
    assert.strictEqual(b1.length, 0, 'mark-only entry emits no block');
    const b2 = inj.buildBlocks('lab', [entry]);
    assert.strictEqual(b2.length, 0, 'mark-only updated cache → subsequent normal call is cache hit');
  });
});

test('markOnlyPaths: non-target entries in same call still emit normally', async () => {
  await withCacheDir(async (cacheDir) => {
    const inj = new CortexMDInjector({ sessionId: 's1', cacheDir });
    const b = inj.buildBlocks(
      'lab',
      [
        { path: '/r/CORTEX.md', content: 'target', mtimeMs: 1 },
        { path: '/CORTEX.md', content: 'ancestor', mtimeMs: 2 },
      ],
      new Set(['/r/CORTEX.md']),
    );
    assert.strictEqual(b.length, 1);
    assert.ok(b[0].text.includes('ancestor'));
    assert.ok(!b[0].text.includes('target'));
  });
});

test('markOnlyPaths: bump mtime on marked entry re-invalidates and marks again', async () => {
  await withCacheDir(async (cacheDir) => {
    const inj = new CortexMDInjector({ sessionId: 's1', cacheDir });
    inj.buildBlocks('lab', [{ path: '/r/CORTEX.md', content: 'v1', mtimeMs: 1 }], new Set(['/r/CORTEX.md']));
    const b = inj.buildBlocks('lab', [{ path: '/r/CORTEX.md', content: 'v2', mtimeMs: 2 }], new Set(['/r/CORTEX.md']));
    assert.strictEqual(b.length, 0, 'new mtime still mark-only — still suppressed');
    const b2 = inj.buildBlocks('lab', [{ path: '/r/CORTEX.md', content: 'v2', mtimeMs: 2 }]);
    assert.strictEqual(b2.length, 0, 'cache now reflects v2 mtime');
  });
});
