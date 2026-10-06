import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { acquireBrowser, releaseBrowser, stopBrowser, browserStatus } from '@platform/browser/managed-browser.js';
import { makeFakeBrowserKit, isAlive, waitUntil, type FakeBrowserKit } from './_fake-browser.js';

// One file on purpose: the launcher picks a CDP port by probing, so two files launching fakes in
// parallel can both pick the same one.

const display = vi.hoisted(() => ({ virtual: false }));
// The virtual-display tests force that path regardless of what this host has; the fake Xvfb on
// PATH stands in for the real one.
vi.mock('@platform/browser/display.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('@platform/browser/display.js')>();
  return {
    ...real,
    resolveBrowserDisplay: (env?: NodeJS.ProcessEnv) =>
      display.virtual
        ? ({ mode: 'virtual', display: null, takeover: 'vnc-required', reason: 'test' })
        : real.resolveBrowserDisplay(env),
  };
});

let kit: FakeBrowserKit;
let savedPath: string | undefined;

beforeAll(() => {
  kit = makeFakeBrowserKit();
  savedPath = process.env.PATH;
  process.env.PATH = `${kit.binDir}:${savedPath}`;
  process.env.CORTEX_BROWSER_BINARY = kit.chrome;
  process.env.FAKE_BROWSER_LOG = kit.logDir;
});

afterEach(() => {
  stopBrowser();
  delete process.env.FAKE_CHROME_DELAY_MS;
  delete process.env.FAKE_CHROME_MODE;
  delete process.env.FAKE_XVFB_DELAY_MS;
});

afterAll(() => {
  process.env.PATH = savedPath;
  kit.cleanup();
});

const latest = (kind: 'chrome' | 'xvfb') => kit.spawned(kind).at(-1)!;

describe('managed browser lifecycle', () => {
  // A pinned display skips the X probes and Xvfb entirely.
  beforeEach(() => {
    display.virtual = false;
    process.env.CORTEX_BROWSER_DISPLAY = ':4242';
  });
  afterEach(() => {
    delete process.env.CORTEX_BROWSER_DISPLAY;
  });

  it('a stop that lands while Chrome is still starting kills it instead of publishing it', async () => {
    // Shutdown during a turn's first acquire: the launch must not outlive the stop, or Chrome runs
    // forever with no refs and no idle timer to reclaim it.
    process.env.FAKE_CHROME_DELAY_MS = '1500';
    const before = kit.spawned('chrome').length;
    const pending = acquireBrowser();
    await waitUntil(() => kit.spawned('chrome').length > before);
    const { pid } = kit.spawned('chrome').at(-1)!;

    stopBrowser();

    await expect(pending).rejects.toThrow(/stopped/);
    expect(browserStatus()).toMatchObject({ running: false, refs: 0 });
    await waitUntil(() => !isAlive(pid));
  });

  it('keeps the refcount honest after a cancelled launch', async () => {
    process.env.FAKE_CHROME_DELAY_MS = '1500';
    const before = kit.spawned('chrome').length;
    const pending = acquireBrowser();
    await waitUntil(() => kit.spawned('chrome').length > before);
    stopBrowser();
    await expect(pending).rejects.toThrow();

    delete process.env.FAKE_CHROME_DELAY_MS;
    const browser = await acquireBrowser();
    expect(browserStatus()).toMatchObject({ running: true, refs: 1 });
    releaseBrowser();
    expect(browserStatus().refs).toBe(0);

    stopBrowser();
    await waitUntil(() => !isAlive(browser.pid));
  });

  it('fails an acquire promptly when Chrome dies at startup, instead of waiting out the CDP timeout', async () => {
    process.env.FAKE_CHROME_MODE = 'exit';
    const t0 = Date.now();
    await expect(acquireBrowser()).rejects.toThrow(/exited/);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(browserStatus()).toMatchObject({ running: false, refs: 0 });
  });
});

describe('managed browser on a virtual display', () => {
  beforeEach(() => {
    display.virtual = true;
  });

  it('launches Chrome only once Xvfb is ready, on the display Xvfb got', async () => {
    // The fake Chrome dies unless its display is already up, as the real one does.
    process.env.FAKE_CHROME_MODE = 'require-display';
    process.env.FAKE_XVFB_DELAY_MS = '500';

    const browser = await acquireBrowser();

    expect(browser.display.display).toBe(latest('xvfb').display);
    expect(latest('chrome').display).toBe(latest('xvfb').display);
    stopBrowser();
    await waitUntil(() => !isAlive(latest('xvfb').pid) && !isAlive(browser.pid));
  });

  it('takes Xvfb down when Chrome fails to start', async () => {
    process.env.FAKE_CHROME_MODE = 'exit';

    await expect(acquireBrowser()).rejects.toThrow(/exited/);

    await waitUntil(() => !isAlive(latest('xvfb').pid));
    expect(browserStatus().running).toBe(false);
  });

  it('a stop while Xvfb is still coming up kills it and never starts Chrome', async () => {
    process.env.FAKE_XVFB_DELAY_MS = '1500';
    const chromes = kit.spawned('chrome').length;
    const xvfbs = kit.spawned('xvfb').length;
    const pending = acquireBrowser();
    await waitUntil(() => kit.spawned('xvfb').length > xvfbs);

    stopBrowser();

    await expect(pending).rejects.toThrow(/stopped/);
    await waitUntil(() => !isAlive(latest('xvfb').pid));
    expect(kit.spawned('chrome').length).toBe(chromes);
  });
});
