import { describe, expect, it } from 'vitest';
import {
  absolutizePaths, isLocalCommand, parseBrowserArgs, runBrowserCli, BrowserUsageError, type BrowserCliOptions,
} from '../../src/entry/browser-cli.js';

const LEASE = {
  device: 'server', cdpEndpoint: 'http://127.0.0.1:9222', abSession: 'cortex-s1-server',
  bin: '/opt/ab', env: { PATH: '/bin', AGENT_BROWSER_SOCKET_DIR: '/run/ab' },
};
const ENV = { CORTEX_SESSION_ID: 's1', CORTEX_WEBHOOK_TOKEN: 'tok', WEBHOOK_PORT: '3999' };

function usage(argv: string[]): string {
  try { parseBrowserArgs(argv); } catch (e) { if (e instanceof BrowserUsageError) return e.message; throw e; }
  return '';
}

describe('parseBrowserArgs', () => {
  it('takes --device anywhere and passes everything else through', () => {
    expect(parseBrowserArgs(['--device', 'my-pc', 'open', 'https://a.test'])).toMatchObject({
      device: 'my-pc', args: ['open', 'https://a.test'], command: 'open', help: false,
    });
    expect(parseBrowserArgs(['snapshot', '-i', '--device=desk'])).toMatchObject({ device: 'desk', args: ['snapshot', '-i'] });
    expect(parseBrowserArgs(['--json', 'get', 'title']).command).toBe('get');
    expect(parseBrowserArgs(['--max-output', '500', 'snapshot']).command).toBe('snapshot');
  });

  it('shows help when there is no command', () => {
    expect(parseBrowserArgs([]).help).toBe(true);
    expect(parseBrowserArgs(['--help']).help).toBe(true);
    expect(parseBrowserArgs(['--device', 'x']).help).toBe(true);
    expect(parseBrowserArgs(['open', '--help']).help).toBe(false);
  });

  it('rejects flags that would leave the session tab, with a fix', () => {
    expect(usage(['--cdp', '9222', 'open', 'x'])).toContain('--cdp is set by cortex-browser');
    expect(usage(['--session=other', 'snapshot'])).toContain('--session is set by cortex-browser');
    expect(usage(['--no-pin-tab', 'open', 'x'])).toContain('Hint: ');
    expect(usage(['--device'])).toContain('--device requires a device name');
  });

  it('blocks commands that would change the shared setup', () => {
    expect(usage(['upgrade'])).toContain("'upgrade' is not available");
    expect(usage(['connect', '9222'])).toContain("'connect' is not available");
    expect(usage(['close', '--all'])).toContain("every other session's browser");
    expect(usage(['close'])).toBe('');
  });

  it('runs help, version and bundled skills without a browser', () => {
    expect(isLocalCommand(parseBrowserArgs(['skills', 'get', 'core']))).toBe(true);
    expect(isLocalCommand(parseBrowserArgs(['--version']))).toBe(true);
    expect(isLocalCommand(parseBrowserArgs(['open', '--help']))).toBe(true);
    expect(isLocalCommand(parseBrowserArgs(['open', 'x']))).toBe(false);
  });
});

describe('absolutizePaths', () => {
  const cwd = '/work';
  it('makes file arguments absolute against the caller', () => {
    expect(absolutizePaths(['screenshot', 'shot.png'], cwd)).toEqual(['screenshot', '/work/shot.png']);
    expect(absolutizePaths(['screenshot', '--full', './out/a.jpg'], cwd)).toEqual(['screenshot', '--full', '/work/out/a.jpg']);
    expect(absolutizePaths(['pdf', 'page.pdf'], cwd)).toEqual(['pdf', '/work/page.pdf']);
    expect(absolutizePaths(['download', '#save.pdf', 'out.pdf'], cwd)).toEqual(['download', '#save.pdf', '/work/out.pdf']);
    expect(absolutizePaths(['upload', '@e5', 'a.png', 'b.txt'], cwd)).toEqual(['upload', '@e5', '/work/a.png', '/work/b.txt']);
    expect(absolutizePaths(['record', 'start', 'demo.webm', 'https://x.test/a.html'], cwd))
      .toEqual(['record', 'start', '/work/demo.webm', 'https://x.test/a.html']);
    expect(absolutizePaths(['--screenshot-dir', 'shots', 'screenshot'], cwd)).toEqual(['--screenshot-dir', '/work/shots', 'screenshot']);
  });

  it('leaves selectors, refs, URLs, patterns and absolute paths alone', () => {
    expect(absolutizePaths(['screenshot', '/tmp/a.png'], cwd)).toEqual(['screenshot', '/tmp/a.png']);
    expect(absolutizePaths(['fill', '@e3', 'notes.txt'], cwd)).toEqual(['fill', '@e3', 'notes.txt']);
    expect(absolutizePaths(['network', 'route', '*.png', '--abort'], cwd)).toEqual(['network', 'route', '*.png', '--abort']);
    expect(absolutizePaths(['screenshot', '.btn'], cwd)).toEqual(['screenshot', '.btn']);
  });
});

interface Calls {
  posts: Array<{ url: string; body: any; headers: Record<string, string> }>;
  execs: Array<{ bin: string; args: string[]; env: Record<string, string>; quiet?: boolean }>;
  err: string;
}

function harness(opts: {
  reply?: (body: any) => { status: number; body: any } | Promise<{ status: number; body: any }>;
  exec?: (args: string[]) => { code: number; stderr: string };
  env?: Record<string, string>;
} = {}): { calls: Calls; options: BrowserCliOptions } {
  const calls: Calls = { posts: [], execs: [], err: '' };
  const options: BrowserCliOptions = {
    env: opts.env ?? ENV,
    cwd: '/work',
    slowNoticeMs: 5,
    post: async (url, body, headers) => {
      calls.posts.push({ url, body, headers });
      if ((body as any).action === 'report') return { status: 200, body: { success: true } };
      return opts.reply ? opts.reply(body) : { status: 200, body: { success: true, data: LEASE } };
    },
    exec: async (bin, args, env, _cwd, quiet) => {
      calls.execs.push({ bin, args, env, ...(quiet ? { quiet } : {}) });
      return opts.exec ? opts.exec(args) : { code: 0, stderr: '' };
    },
    writeErr: (text) => { calls.err += text; },
  };
  return { calls, options };
}

describe('runBrowserCli', () => {
  it('leases, runs agent-browser attached to the session tab, then reports', async () => {
    const { calls, options } = harness();
    const code = await runBrowserCli(['--device', 'server', 'screenshot', 'a.png'], options);
    expect(code).toBe(0);
    expect(calls.posts[0]).toEqual({
      url: 'http://127.0.0.1:3999/webhook/browser',
      body: { action: 'lease', sessionId: 's1', device: 'server' },
      headers: { 'x-cortex-token': 'tok' },
    });
    expect(calls.execs).toEqual([{
      bin: '/opt/ab',
      args: ['--cdp', 'http://127.0.0.1:9222', '--session', 'cortex-s1-server', '--pin-tab', 'screenshot', '/work/a.png'],
      env: LEASE.env,
    }]);
    expect(calls.posts[1].body).toEqual({ action: 'report', sessionId: 's1' });
  });

  it("passes agent-browser's exit code and stderr through", async () => {
    const { calls, options } = harness({ exec: () => ({ code: 1, stderr: '✗ Navigation failed: net::ERR_CONNECTION_REFUSED\n' }) });
    expect(await runBrowserCli(['open', 'http://127.0.0.1:1'], options)).toBe(1);
    expect(calls.err).toBe('✗ Navigation failed: net::ERR_CONNECTION_REFUSED\n');
  });

  it('rebinds a new tab and retries once when the bound tab is gone', async () => {
    let gone = true;
    const { calls, options } = harness({
      exec: (args) => {
        if (args.slice(5).join(' ') === 'tab new') { gone = false; return { code: 0, stderr: '' }; }
        return gone ? { code: 1, stderr: '✗ tab_gone: bound tab is gone\n' } : { code: 0, stderr: '' };
      },
    });
    expect(await runBrowserCli(['snapshot'], options)).toBe(0);
    expect(calls.execs.map((e) => e.args.slice(5).join(' '))).toEqual(['snapshot', 'tab new', 'set viewport 1280 800', 'snapshot']);
    expect(calls.execs.map((e) => !!e.quiet)).toEqual([false, true, true, false]);
    expect(calls.err).toContain("previous tab is gone");
    expect(calls.err).not.toContain('tab_gone');
  });

  it('fails with the broker\'s reason and hint, never falling back', async () => {
    const { calls, options } = harness({
      reply: () => ({ status: 200, body: { success: false, error: 'device "laptop" is offline', hint: 'start its Cortex client', code: 'device-offline' } }),
    });
    expect(await runBrowserCli(['--device', 'laptop', 'open', 'x'], options)).toBe(1);
    expect(calls.err).toBe('browser unavailable: device "laptop" is offline\nHint: start its Cortex client\n');
    expect(calls.execs).toEqual([]);
  });

  it('explains an unreachable daemon, a rejected token and an old server', async () => {
    const down = harness({ reply: () => { throw new Error('fetch failed'); } });
    expect(await runBrowserCli(['open', 'x'], down.options)).toBe(1);
    expect(down.calls.err).toContain('cannot reach the Cortex daemon at 127.0.0.1:3999');

    const denied = harness({ reply: () => ({ status: 401, body: 'Unauthorized' }) });
    expect(await runBrowserCli(['open', 'x'], denied.options)).toBe(1);
    expect(denied.calls.err).toContain('CORTEX_WEBHOOK_TOKEN');

    const old = harness({ reply: () => ({ status: 404, body: 'Not found' }) });
    expect(await runBrowserCli(['open', 'x'], old.options)).toBe(1);
    expect(old.calls.err).toContain('no browser endpoint');
  });

  it('needs a session, and says so', async () => {
    const { calls, options } = harness({ env: { CORTEX_WEBHOOK_TOKEN: 'tok' } });
    expect(await runBrowserCli(['open', 'x'], options)).toBe(2);
    expect(calls.err).toContain('CORTEX_SESSION_ID is unset');
    expect(calls.posts).toEqual([]);
  });

  it('tells the caller when the browser is slow to start', async () => {
    const { calls, options } = harness({
      reply: () => new Promise((r) => setTimeout(() => r({ status: 200, body: { success: true, data: LEASE } }), 30)),
    });
    expect(await runBrowserCli(['--device', 'desk', 'open', 'x'], options)).toBe(0);
    expect(calls.err).toBe('cortex-browser: starting the browser on desk…\n');
  });

  it('exits 2 on a usage error without contacting the daemon', async () => {
    const { calls, options } = harness();
    expect(await runBrowserCli(['--session', 'x', 'open', 'y'], options)).toBe(2);
    expect(calls.posts).toEqual([]);
  });
});
