// input:  fullscreen controller and deterministic native flags
// output: Windows geometry workaround and rollback regressions
// pos:    Native fullscreen transition contract tests
// >>> Once updated, update this header and parent CORTEX.md <<<
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFullscreenController } from './window-commands';

let full = false;
let maximized = true;
let fail: string | null = null;
let calls: string[];
const invoke = vi.fn(async (command: string, args?: { value?: boolean }) => {
  const name = command.split('|')[1]!;
  calls.push(name);
  if (name === fail) throw new Error('fixture denied');
  if (name === 'is_fullscreen') return full;
  if (name === 'is_maximized') return maximized;
  if (name === 'unmaximize') maximized = false;
  if (name === 'maximize') maximized = true;
  if (name === 'set_fullscreen') full = args!.value!;
});
beforeEach(() => {
  full = false; maximized = true; fail = null; calls = [];
  vi.stubGlobal('__TAURI__', { core: { invoke } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });
const writes = () => calls.filter(name => !name.startsWith('is_'));

describe('fullscreen controller', () => {
  it('unmaximizes Windows before fullscreen and restores maximize after exit', async () => {
    const controller = createFullscreenController('windows');
    await controller.toggle();
    expect({ full, maximized }).toEqual({ full: true, maximized: false });
    expect(writes()).toEqual(['unmaximize', 'set_fullscreen']);
    await controller.toggle();
    expect({ full, maximized }).toEqual({ full: false, maximized: true });
    expect(writes()).toEqual(['unmaximize', 'set_fullscreen', 'set_fullscreen', 'maximize']);
  });
  it.each(['macos', 'linux'] as const)('leaves %s maximize semantics to the OS', async platform => {
    const controller = createFullscreenController(platform);
    await controller.toggle(); await controller.exit();
    expect(writes()).toEqual(['set_fullscreen', 'set_fullscreen']);
  });
  it('restores a normal Windows window without maximizing it', async () => {
    maximized = false;
    const controller = createFullscreenController('windows');
    await controller.toggle(); await controller.exit();
    expect(maximized).toBe(false);
    expect(writes()).toEqual(['set_fullscreen', 'set_fullscreen']);
  });
  it('ignores repeated concurrent toggles and Escape never enters fullscreen', async () => {
    const controller = createFullscreenController('windows');
    await Promise.all([controller.toggle(), controller.toggle(), controller.toggle()]);
    expect(full).toBe(true);
    expect(writes()).toEqual(['unmaximize', 'set_fullscreen']);
    await controller.exit();
    const count = calls.length;
    await controller.exit();
    expect(calls.slice(count)).toEqual(['is_fullscreen']);
  });
  it('does not enter fullscreen after a failed native state query', async () => {
    fail = 'is_fullscreen';
    await expect(createFullscreenController('windows').toggle()).rejects.toThrow();
    expect(writes()).toEqual([]);
  });
  it('rolls back maximize if entering fullscreen fails and allows a retry', async () => {
    const controller = createFullscreenController('windows');
    fail = 'set_fullscreen';
    await expect(controller.toggle()).rejects.toThrow();
    expect(maximized).toBe(true);
    fail = null;
    await controller.toggle();
    expect(full).toBe(true);
  });
  it('waits for unmaximize to settle before requesting fullscreen', async () => {
    vi.useFakeTimers();
    let resolveUnmaximize!: () => void;
    invoke.mockImplementationOnce(async () => false);
    invoke.mockImplementationOnce(async () => true);
    invoke.mockImplementationOnce(async () => {
      setTimeout(() => { maximized = false; resolveUnmaximize(); }, 100);
      return undefined;
    });
    const unmaximized = new Promise<void>(resolve => { resolveUnmaximize = resolve; });
    const promise = createFullscreenController('windows').toggle();
    await vi.advanceTimersByTimeAsync(50);
    expect(full).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await unmaximized; await promise;
    expect(full).toBe(true);
  });
});
