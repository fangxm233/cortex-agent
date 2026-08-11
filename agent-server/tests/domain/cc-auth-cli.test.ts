// input:  Claude auth CLI adapter and fake child processes
// output: login, status, logout, cancellation, and privacy tests
// pos:    Claude-owned authentication CLI contract tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test, vi } from 'vitest';
import {
  loginClaudeAuth,
  logoutClaudeAuth,
  readClaudeAuthStatus,
  type ClaudeAuthCliDependencies,
} from '../../src/domain/auth/cc-auth-cli.js';

const AUTH_URL = 'https://claude.com/cai/oauth/authorize?code=true&state=fixture';
const CODE = 'fixture-code#fixture-state';

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly writes: string[] = [];
  readonly stdin = {
    write: (value: string) => {
      this.writes.push(value);
      this.onWrite?.(value);
      return true;
    },
    end: vi.fn(),
  };
  killed = false;
  onWrite?: (value: string) => void;

  close(code: number | null): void {
    this.emit('close', code, null);
  }

  kill(): boolean {
    this.killed = true;
    this.close(null);
    return true;
  }
}

interface SpawnCall {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  child: FakeChild;
}

function fakeDependencies(
  start: (call: SpawnCall, index: number) => void,
): { dependencies: ClaudeAuthCliDependencies; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  return {
    calls,
    dependencies: {
      executable: 'claude-fixture',
      timeoutMs: 1_000,
      spawn: ((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        const call = { command, args, env: options.env, child: new FakeChild() };
        calls.push(call);
        queueMicrotask(() => start(call, calls.length - 1));
        return call.child;
      }) as unknown as ClaudeAuthCliDependencies['spawn'],
    },
  };
}

function emitStatus(call: SpawnCall, loggedIn: boolean): void {
  call.child.stdout.end(JSON.stringify({
    loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none', apiProvider: 'firstParty',
  }));
  call.child.close(0);
}

test('login uses claude auth login pipes, forwards code once, and verifies CLI-owned status', async () => {
  const fixture = fakeDependencies((call, index) => {
    if (index === 0) {
      call.child.stdout.write('Opening browser to sign in…\nIf the browser did not open, visit: ');
      call.child.stderr.write(`\u001b]8;;${AUTH_URL}\u0007${AUTH_URL.slice(0, 32)}`);
      call.child.stdout.write(`${AUTH_URL.slice(32)}\nPaste code here if prompted > `);
      call.child.onWrite = value => {
        assert.equal(value, `${CODE}\n`);
        call.child.close(0);
      };
      return;
    }
    emitStatus(call, true);
  });
  fixture.dependencies.env = {
    HOME: '/fixture/home', PATH: '/fixture/bin', LANG: 'C.UTF-8',
    SLACK_BOT_TOKEN: 'xoxb-fixture-secret', AWS_SECRET_ACCESS_KEY: 'fixture-cloud-secret',
  };
  let offeredUrl = '';

  const status = await loginClaudeAuth({
    onAuthorization: async url => {
      offeredUrl = url;
      return CODE;
    },
  }, fixture.dependencies);

  assert.equal(offeredUrl, AUTH_URL);
  assert.equal(status.loggedIn, true);
  assert.deepEqual(fixture.calls.map(call => call.args), [
    ['auth', 'login', '--claudeai'],
    ['auth', 'status', '--json'],
  ]);
  assert.deepEqual(fixture.calls[0].child.writes, [`${CODE}\n`]);
  for (const call of fixture.calls) {
    assert.equal(call.command, 'claude-fixture');
    assert.equal(call.env.BROWSER, 'true');
    assert.equal(call.env.HOME, '/fixture/home');
    assert.equal(call.env.PATH, '/fixture/bin');
    assert.equal(call.env.LANG, 'C.UTF-8');
    assert.equal(call.env.SLACK_BOT_TOKEN, undefined);
    assert.equal(call.env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(call.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(call.env.CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT, undefined);
    assert.equal(call.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(call.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(call.env.ANTHROPIC_BASE_URL, undefined);
  }
  assert.equal(JSON.stringify(status).includes(CODE), false);
});

test('login rejects exit zero when scrubbed claude auth status is still logged out', async () => {
  const fixture = fakeDependencies((call, index) => {
    if (index === 0) {
      call.child.stdout.write(`${AUTH_URL}\nPaste code here if prompted > `);
      call.child.onWrite = () => call.child.close(0);
      return;
    }
    emitStatus(call, false);
  });

  await assert.rejects(
    loginClaudeAuth({ onAuthorization: async () => CODE }, fixture.dependencies),
    (error: any) => error?.code === 'claude_auth_not_logged_in'
      && !String(error.message).includes(CODE),
  );
});

test('readClaudeAuthStatus rejects malformed or secret-bearing command output safely', async () => {
  const fixture = fakeDependencies(call => {
    call.child.stdout.end(`not-json-${CODE}`);
    call.child.close(0);
  });

  await assert.rejects(
    readClaudeAuthStatus(fixture.dependencies),
    (error: any) => error?.code === 'claude_auth_status_invalid'
      && !String(error.message).includes(CODE),
  );
});

test('login rejects when the CLI exits after prompting but before code submission', async () => {
  const fixture = fakeDependencies(call => {
    call.child.stdout.write(`${AUTH_URL}\nPaste code here if prompted > `);
    queueMicrotask(() => call.child.close(0));
  });
  const pending = loginClaudeAuth({
    onAuthorization: async () => new Promise<string>(() => {}),
  }, fixture.dependencies);
  const deadline = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('test deadline exceeded')), 50);
  });

  await assert.rejects(
    Promise.race([pending, deadline]),
    (error: any) => error?.code === 'claude_auth_login_protocol',
  );
});

test('login cancellation kills the child without waiting for authorization input', async () => {
  const fixture = fakeDependencies(call => {
    call.child.stdout.write(`${AUTH_URL}\nPaste code here if prompted > `);
  });
  const controller = new AbortController();
  const pending = loginClaudeAuth({
    signal: controller.signal,
    onAuthorization: async () => new Promise<string>(() => {}),
  }, fixture.dependencies);
  await new Promise(resolve => setTimeout(resolve, 0));

  controller.abort();

  await assert.rejects(pending, (error: any) => error?.code === 'claude_auth_cancelled');
  assert.equal(fixture.calls[0].child.killed, true);
  assert.deepEqual(fixture.calls[0].child.writes, []);
});

test('login timeout kills the pending CLI without exposing buffered output', async (t) => {
  vi.useFakeTimers();
  t.onTestFinished(() => { vi.useRealTimers(); });
  const fixture = fakeDependencies(call => {
    call.child.stdout.write(`${AUTH_URL}\nPaste code here if prompted > `);
  });
  fixture.dependencies.timeoutMs = 25;
  const pending = loginClaudeAuth({
    onAuthorization: async () => new Promise<string>(() => {}),
  }, fixture.dependencies);
  const rejected = assert.rejects(
    pending,
    (error: any) => error?.code === 'claude_auth_timeout'
      && !String(error.message).includes(AUTH_URL),
  );

  await vi.advanceTimersByTimeAsync(30);

  await rejected;
  assert.equal(fixture.calls[0].child.killed, true);
});

test('logout delegates to Claude and verifies the scrubbed logged-out postcondition', async () => {
  const fixture = fakeDependencies((call, index) => {
    if (index === 0) call.child.close(0);
    else emitStatus(call, false);
  });

  await logoutClaudeAuth(fixture.dependencies);

  assert.deepEqual(fixture.calls.map(call => call.args), [
    ['auth', 'logout'],
    ['auth', 'status', '--json'],
  ]);
});
