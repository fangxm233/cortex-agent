// input:  synthetic nvidia-smi runners (stdout strings / throwing stubs)
// output: assertions on count parsing, unknown-vs-zero, and probe caching
// pos:    Covers the client GPU-count probe reported in the hello frame
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { detectGpuCount, resetGpuCountCacheForTesting } = await import('../../src/gpu-detect.js');

beforeEach(() => resetGpuCountCacheForTesting());

describe('detectGpuCount', () => {
  it('reads the total from the first line (nvidia-smi repeats it per GPU)', () => {
    assert.equal(detectGpuCount(() => '2\n2\n'), 2);
  });

  it('accepts a single-GPU host', () => {
    assert.equal(detectGpuCount(() => '1\n'), 1);
  });

  it('reports unknown (null) when nvidia-smi is absent or fails', () => {
    assert.equal(detectGpuCount(() => { throw new Error('ENOENT'); }), null);
  });

  it('reports unknown (null) on unparseable output rather than guessing zero', () => {
    assert.equal(detectGpuCount(() => 'Failed to initialize NVML\n'), null);
    assert.equal(detectGpuCount(() => ''), null);
  });

  it('rejects an implausible count instead of writing it to the registry', () => {
    assert.equal(detectGpuCount(() => '999\n'), null);
  });

  it('caches a successful probe so a reconnect storm spawns nvidia-smi once', () => {
    let calls = 0;
    const run = () => { calls++; return '4\n'; };
    assert.equal(detectGpuCount(run), 4);
    assert.equal(detectGpuCount(run), 4);
    assert.equal(calls, 1);
  });

  it('does not cache a failure — the driver may come up later', () => {
    let calls = 0;
    assert.equal(detectGpuCount(() => { calls++; throw new Error('no driver'); }), null);
    assert.equal(detectGpuCount(() => { calls++; return '1\n'; }), 1);
    assert.equal(calls, 2);
  });
});
