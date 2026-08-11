// input:  mounted login overlay, tRPC/navigation fakes, targets
// output: responsive layout, flow, prompt, and non-echo regressions
// pos:    Mounted Web authentication workflow specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthNoticeAction, LoginFlowNotice, LoginFlowState } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';

const harness = vi.hoisted(() => ({
  startCalls: [] as unknown[],
  respondCalls: [] as unknown[],
  cancelCalls: [] as unknown[],
  flowQueries: [] as any[],
  invalidations: [] as unknown[],
  mutationKinds: [] as string[],
  startState: null as LoginFlowState | null,
  respondState: null as LoginFlowState | null,
  cancelState: null as LoginFlowState | null,
  queryState: null as LoginFlowState | null,
  startError: null as string | null,
  startPromise: null as Promise<LoginFlowState> | null,
  respondPromise: null as Promise<LoginFlowState> | null,
  externalUrls: [] as string[],
  mobile: false,
}));

vi.mock('@/design', () => ({
  Modal: ({ open, title, description, hideDescription, children, footer }: any) => open
    ? <div data-auth-modal="true" data-description-hidden={hideDescription}>
      <h1>{title}</h1>
      {description ? <p hidden={hideDescription}>{description}</p> : null}
      {children}<footer>{footer}</footer>
    </div>
    : null,
  Button: (props: any) => <button {...props}>{props.children}</button>,
  Select: ({ options, value, ...props }: any) => (
    <div data-select-control data-select-value={String(value)} {...props}>
      {options.map((option: any) => (
        <span key={String(option.value)} data-option-value={String(option.value)}>{option.label}</span>
      ))}
    </div>
  ),
}));

vi.mock('@/lib/desktop-config', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/desktop-config')>(),
  isMobileShell: () => harness.mobile,
}));

vi.mock('@/lib/external-navigation', () => ({
  openExternalUrl: async (url: string) => { harness.externalUrls.push(url); },
}));

vi.mock('@/mobile/ui/kit', () => ({
  MBottomSheet: ({ children }: any) => <div data-mobile-bottom-sheet>{children}</div>,
}));

vi.mock('@/lib/trpc', () => ({
  useTRPCClient: () => ({
    auth: {
      startLogin: {
        mutate: async (variables: unknown) => {
          harness.startCalls.push(variables);
          if (harness.startError) throw new Error(harness.startError);
          if (harness.startPromise) return harness.startPromise;
          return harness.startState;
        },
      },
      respondPrompt: {
        mutate: async (variables: unknown) => {
          harness.respondCalls.push(variables);
          if (harness.respondPromise) return harness.respondPromise;
          return harness.respondState;
        },
      },
      cancelFlow: {
        mutate: async (variables: unknown) => {
          harness.cancelCalls.push(variables);
          return harness.cancelState;
        },
      },
    },
  }),
  useTRPC: () => {
    const query = (kind: string) => ({
      queryOptions: (input: unknown, options: unknown = {}) => ({ __kind: kind, input, ...options as object }),
      queryFilter: (input: unknown = {}) => ({ __kind: kind, input }),
    });
    const mutation = (kind: string) => ({
      mutationOptions: (options: unknown = {}) => ({ __kind: kind, ...options as object }),
    });
    return {
      auth: {
        status: query('auth.status'),
        flowState: query('auth.flowState'),
        startLogin: mutation('auth.startLogin'),
        respondPrompt: mutation('auth.respondPrompt'),
        cancelFlow: mutation('auth.cancelFlow'),
      },
    };
  },
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: (options: any) => {
      if (options.__kind === 'auth.status') return { data: authStatus(), isPending: false };
      if (options.__kind === 'auth.flowState') {
        harness.flowQueries.push(options);
        return {
          data: options.enabled ? harness.queryState : undefined,
          isPending: false,
          isSuccess: options.enabled,
        };
      }
      throw new Error(`Unexpected query ${String(options.__kind)}`);
    },
    useMutation: (options: any) => {
      harness.mutationKinds.push(options.__kind);
      return {
      isPending: false,
      mutate: (variables: unknown) => {
        if (options.__kind === 'auth.startLogin') {
          harness.startCalls.push(variables);
          if (harness.startError) options.onError?.(new Error(harness.startError), variables);
          else if (harness.startPromise) void harness.startPromise.then(value => options.onSuccess?.(value, variables));
          else options.onSuccess?.(harness.startState, variables);
        } else if (options.__kind === 'auth.cancelFlow') {
          harness.cancelCalls.push(variables);
          options.onSuccess?.(harness.cancelState, variables);
        }
      },
    };
    },
    useQueryClient: () => ({
      invalidateQueries: (filter: unknown) => { harness.invalidations.push(filter); },
    }),
  };
});

import { ChatNotice } from '@/features/workbench/ChatNotice';
import { LoginFlowModal, type LoginFlowModalProps } from './LoginFlowModal';
import { LoginFlowProvider } from './LoginFlowProvider';

function state(
  step: LoginFlowState['step'],
  overrides: Partial<LoginFlowState> = {},
): LoginFlowState {
  return {
    flowId: 'flow-web', backend: 'claude', provider: 'anthropic', authType: 'api_key',
    step,
    pendingPrompt: step === 'prompt' ? { kind: 'secret', message: 'Enter key' } : null,
    notice: null, channel: null, sessionId: null,
    createdAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:30:00.000Z',
    outcome: step === 'done'
      ? { provider: 'anthropic', authType: 'api_key', expiresAt: null }
      : null,
    error: null, errorCode: null,
    ...overrides,
  };
}

function authStatus() {
  return {
    generatedAt: '2030-01-01T00:00:00.000Z',
    accounts: [
      { backend: 'claude', provider: 'anthropic', label: 'Anthropic', capabilities: ['api_key', 'oauth'] },
      { backend: 'pi', provider: 'deepseek', label: 'DeepSeek', capabilities: ['api_key'] },
      { backend: 'pi', provider: 'oauth-only', label: 'OAuth only', capabilities: ['oauth'] },
      { backend: 'pi', provider: 'dual-auth', label: 'Dual auth', capabilities: ['api_key', 'oauth'] },
      { backend: 'pi', provider: 'metadata-only', label: 'Metadata only', capabilities: [] },
    ],
    piRuntime: { available: true, version: 'test', entry: null, error: null },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function mount(props: Partial<LoginFlowModalProps> = {}): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <LangProvider><LoginFlowModal open onClose={() => {}} {...props} /></LangProvider>,
    );
  });
  return renderer;
}

const NOTICE_TARGET: AuthNoticeAction = {
  kind: 'auth-login', noticeId: 'notice-web',
  backend: 'pi', provider: 'dual-auth', authType: 'oauth',
};

function NoticeLauncher(): JSX.Element {
  return <ChatNotice level="error" text="Authentication expired" authAction={NOTICE_TARGET} />;
}

function mountProvider(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <LangProvider><LoginFlowProvider><NoticeLauncher /></LoginFlowProvider></LangProvider>,
    );
  });
  return renderer;
}

function click(renderer: ReactTestRenderer, action: string): void {
  act(() => { renderer.root.findByProps({ 'data-action': action }).props.onClick(); });
}

function clickNotice(renderer: ReactTestRenderer): void {
  act(() => { renderer.root.findByProps({ 'data-auth-notice-action': true }).props.onClick(); });
}

function pick(renderer: ReactTestRenderer, field: string, value: string): void {
  act(() => { renderer.root.findByProps({ [`data-auth-${field}`]: true }).props.onValueChange(value); });
}

async function clickAsync(renderer: ReactTestRenderer, action: string): Promise<void> {
  await act(async () => {
    await renderer.root.findByProps({ 'data-action': action }).props.onClick();
  });
}

beforeEach(() => {
  harness.startCalls = [];
  harness.respondCalls = [];
  harness.cancelCalls = [];
  harness.flowQueries = [];
  harness.invalidations = [];
  harness.mutationKinds = [];
  harness.startState = state('prompt');
  harness.respondState = state('done');
  harness.cancelState = state('cancelled');
  harness.queryState = state('prompt');
  harness.startError = null;
  harness.startPromise = null;
  harness.respondPromise = null;
  harness.externalUrls = [];
  harness.mobile = false;
});

const NOTICE_CASES: Array<[LoginFlowNotice, LoginFlowNotice['kind']]> = [
  [{ kind: 'info', message: 'Provider information', links: [{ label: 'Help', url: 'https://help.example.test' }] }, 'info'],
  [{ kind: 'auth_url', url: 'https://login.example.test/authorize?state=fixture', instructions: 'Authorize' }, 'auth_url'],
  [{ kind: 'device_code', userCode: 'ABCD-EFGH', verificationUri: 'https://verify.example.test', expiresInSeconds: 600 }, 'device_code'],
  [{ kind: 'progress', message: 'Waiting for authorization' }, 'progress'],
];

describe('LoginFlowModal', () => {
  it('uses the selected backend and provider names as the flow title', () => {
    const login = state('prompt', {
      authType: 'oauth',
      pendingPrompt: { kind: 'manual_code', message: 'Paste authorization code' },
    });
    const renderer = mount({
      target: { backend: 'claude', provider: 'anthropic', authType: 'oauth' },
      initialState: login,
    });

    expect(renderer.root.findByType('h1').children.join('')).toBe('Claude Code · Anthropic');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Backend login');
  });

  it('renders OAuth as open-page then code-entry without duplicate prompt copy', async () => {
    const message = 'Paste code here if prompted.';
    const login = state('prompt', {
      authType: 'oauth',
      notice: {
        kind: 'auth_url', url: 'https://login.example.test/authorize?state=fixture',
        instructions: message,
      },
      pendingPrompt: { kind: 'manual_code', message },
    });
    harness.queryState = login;
    const renderer = mount({ initialState: login });
    const ordered = renderer.root.findAll(node => (
      node.props['data-auth-open-step'] !== undefined
      || node.props['data-auth-code-step'] !== undefined
    )).map(node => node.props['data-auth-open-step'] !== undefined ? 'open' : 'code');

    expect(ordered).toEqual(['open', 'code']);
    expect(renderer.root.findAllByProps({ 'data-auth-prompt-copy': true })).toHaveLength(1);
    const input = renderer.root.findByProps({ 'data-auth-secret': true });
    expect(input.props.type).toBe('text');
    expect(input.props.autoComplete).toBe('one-time-code');
    expect(input.props.placeholder).toBe('Paste authorization code');
    expect(input.props.className).toContain('border-proto-line-3');
    expect(input.props.className).toContain('bg-surface-canvas-alt');
    const description = renderer.root.findByProps({ hidden: true });
    expect(description.children.join('')).toBe(
      'Open the authorization page. Paste the authorization code.',
    );

    await clickAsync(renderer, 'auth-open-url');
    expect(harness.externalUrls).toEqual(['https://login.example.test/authorize?state=fixture']);
  });

  it('renders terminal success and long failures once inside bounded content', () => {
    const done = mount({ initialState: state('done') });
    expect(done.root.findAllByProps({ 'data-auth-success': true })).toHaveLength(1);
    expect(done.root.findAllByProps({ 'data-auth-flow-step': 'done' })).toHaveLength(1);

    const failed = mount({ initialState: state('failed', {
      error: `Failure ${'unbroken'.repeat(80)}`,
      errorCode: 'fixture_failure',
    }) });
    const error = failed.root.findByProps({ 'data-auth-error': true });
    expect(error.props.className).toContain('break-words');
    expect(error.props.className).toContain('overflow-y-auto');
  });

  it('uses a bottom sheet rather than a centered modal on mobile', () => {
    harness.mobile = true;
    const renderer = mount();

    expect(renderer.root.findAllByProps({ 'data-auth-sheet': true })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-auth-modal': 'true' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-mobile-bottom-sheet': true })).toHaveLength(1);
  });

  it('keeps native authentication selectors on the mobile shell', () => {
    harness.mobile = true;
    const renderer = mount();

    expect(renderer.root.findAllByType('select')).toHaveLength(2);
    expect(renderer.root.findAllByProps({ 'data-select-control': true })).toHaveLength(0);
  });

  it('auto-starts a notice target with the server-selected OAuth capability', async () => {
    harness.startState = state('prompt', {
      backend: 'pi', provider: 'dual-auth', authType: 'oauth',
      pendingPrompt: { kind: 'manual_code', message: 'Enter code' },
    });
    harness.queryState = harness.startState;
    mount({ target: NOTICE_TARGET });
    await act(async () => { await Promise.resolve(); });

    expect(harness.startCalls).toEqual([{
      backend: 'pi', provider: 'dual-auth', authType: 'oauth', noticeId: 'notice-web',
    }]);
  });

  it('auto-starts a settings target without inventing a notice binding', async () => {
    harness.startState = state('prompt', {
      backend: 'pi', provider: 'deepseek', authType: 'api_key',
    });
    harness.queryState = harness.startState;
    mount({ target: { backend: 'pi', provider: 'deepseek', authType: 'api_key' } });
    await act(async () => { await Promise.resolve(); });

    expect(harness.startCalls).toEqual([{
      backend: 'pi', provider: 'deepseek', authType: 'api_key',
    }]);
  });

  it('reopens a terminal notice flow instead of creating another flow', async () => {
    harness.startState = state('done', {
      backend: 'pi', provider: 'dual-auth', authType: 'oauth',
      outcome: { provider: 'dual-auth', authType: 'oauth', expiresAt: null },
    });
    harness.queryState = harness.startState;
    const renderer = mountProvider();
    clickNotice(renderer);
    await act(async () => { await Promise.resolve(); });
    click(renderer, 'auth-close');
    clickNotice(renderer);
    await act(async () => { await Promise.resolve(); });

    expect(harness.startCalls).toHaveLength(1);
    expect(renderer.root.findByProps({ 'data-auth-flow-step': 'done' })).toBeTruthy();
  });

  it('shows cached terminal feedback for an already-bound notice target', () => {
    const terminal = state('done', {
      backend: 'pi', provider: 'dual-auth', authType: 'oauth',
      outcome: { provider: 'dual-auth', authType: 'oauth', expiresAt: null },
    });
    const renderer = mount({ target: NOTICE_TARGET, initialState: terminal });

    expect(harness.startCalls).toHaveLength(0);
    expect(renderer.root.findByProps({ 'data-auth-flow-step': 'done' })).toBeTruthy();
  });

  it('lists all PI providers and skips auth selection for an API-key-only provider', async () => {
    const renderer = mount();
    pick(renderer, 'backend', 'pi');
    const provider = renderer.root.findByProps({ 'data-auth-provider': true });
    expect(provider.props.options.map((option: any) => option.value)).toEqual([
      'deepseek', 'oauth-only', 'dual-auth',
    ]);
    pick(renderer, 'provider', 'deepseek');
    expect(renderer.root.findAllByProps({ 'data-auth-type': true })).toHaveLength(0);
    await clickAsync(renderer, 'auth-start');

    expect(harness.startCalls).toEqual([{ backend: 'pi', provider: 'deepseek', authType: 'api_key' }]);
    expect(harness.flowQueries.at(-1)).toMatchObject({ enabled: true, input: { flowId: 'flow-web' } });
  });

  it('shows auth selection after a dual-capability PI provider', async () => {
    const renderer = mount();
    pick(renderer, 'backend', 'pi');
    pick(renderer, 'provider', 'dual-auth');
    const selectors = renderer.root.findAllByProps({ 'data-select-control': true }).map(node => (
      node.props['data-auth-backend'] ? 'backend'
        : node.props['data-auth-provider'] ? 'provider'
          : node.props['data-auth-type'] ? 'authType' : 'unknown'
    ));
    expect(selectors).toEqual(['backend', 'provider', 'authType']);
    const authType = renderer.root.findByProps({ 'data-auth-type': true });
    expect(authType.props.options.map((option: any) => option.value)).toEqual([
      'api_key', 'oauth',
    ]);
    pick(renderer, 'type', 'oauth');
    await clickAsync(renderer, 'auth-start');

    expect(harness.startCalls).toEqual([{
      backend: 'pi', provider: 'dual-auth', authType: 'oauth',
    }]);
  });

  it('skips auth selection and starts OAuth for an OAuth-only provider', async () => {
    const renderer = mount();
    pick(renderer, 'backend', 'pi');
    pick(renderer, 'provider', 'oauth-only');
    expect(renderer.root.findAllByProps({ 'data-auth-type': true })).toHaveLength(0);
    await clickAsync(renderer, 'auth-start');

    expect(harness.startCalls).toEqual([{
      backend: 'pi', provider: 'oauth-only', authType: 'oauth',
    }]);
  });

  it('polls from the initial running state into the first secret prompt', async () => {
    harness.startState = state('running');
    harness.queryState = state('prompt');
    const renderer = mount();
    await clickAsync(renderer, 'auth-start');

    const input = renderer.root.findByProps({ 'data-auth-secret': true });
    expect(input.props.type).toBe('password');
    expect(input.props['aria-labelledby']).toBe('auth-login-prompt-label');
    expect(renderer.root.findByProps({ id: 'auth-login-prompt-label' }).children.join('')).toContain('API key');
  });

  it('renders manual-code prompts as visible one-time-code inputs', async () => {
    harness.startState = state('prompt', {
      authType: 'oauth',
      pendingPrompt: { kind: 'manual_code', message: 'Paste authorization code' },
    });
    harness.queryState = harness.startState;
    const renderer = mount();
    await clickAsync(renderer, 'auth-start');

    const input = renderer.root.findByProps({ 'data-auth-secret': true });
    expect(input.props.type).toBe('text');
    expect(input.props.autoComplete).toBe('one-time-code');
  });

  it('submits the exact id selected by an interactive login prompt', async () => {
    harness.startState = state('prompt', {
      pendingPrompt: {
        kind: 'select', message: 'Region',
        options: [{ id: 'us', label: 'US' }, { id: 'eu', label: 'EU' }],
      },
    });
    harness.queryState = harness.startState;
    const renderer = mount();
    await clickAsync(renderer, 'auth-start');

    const prompt = renderer.root.findByProps({ 'data-auth-secret': true });
    expect(prompt.props.options.map((option: any) => option.value)).toEqual(['us', 'eu']);
    act(() => { prompt.props.onValueChange('eu'); });
    await clickAsync(renderer, 'auth-submit');

    expect(harness.respondCalls).toEqual([{ flowId: 'flow-web', value: 'eu' }]);
  });

  it('does not echo a submitted OAuth redirect URL', async () => {
    harness.startState = state('prompt', {
      authType: 'oauth',
      pendingPrompt: { kind: 'manual_code', message: 'Paste redirect URL' },
    });
    harness.queryState = harness.startState;
    const renderer = mount();
    await clickAsync(renderer, 'auth-start');
    const redirect = 'https://localhost/callback?code=sentinel-web-code&state=private';
    act(() => {
      renderer.root.findByProps({ 'data-auth-secret': true }).props.onChange({ target: { value: redirect } });
    });
    await clickAsync(renderer, 'auth-submit');

    expect(harness.respondCalls).toEqual([{ flowId: 'flow-web', value: redirect }]);
    expect(JSON.stringify(renderer.toJSON())).not.toContain(redirect);
  });

  it('uses an uncached direct mutation and never re-renders a submitted secret', async () => {
    const renderer = mount();
    await clickAsync(renderer, 'auth-start');
    const input = renderer.root.findByProps({ 'data-auth-secret': true });
    expect(input.props.type).toBe('password');

    const secret = 'sentinel-web-secret';
    act(() => { input.props.onChange({ target: { value: secret } }); });
    expect(renderer.root.findByProps({ 'data-auth-secret': true }).props.value).toBe(secret);
    await clickAsync(renderer, 'auth-submit');

    expect(harness.respondCalls).toEqual([{ flowId: 'flow-web', value: secret }]);
    expect(harness.mutationKinds).not.toContain('auth.respondPrompt');
    expect(JSON.stringify(renderer.toJSON())).not.toContain(secret);
    expect(renderer.root.findByProps({ 'data-auth-flow-step': 'done' })).toBeTruthy();
    expect(harness.invalidations.some((entry: any) => entry.__kind === 'auth.status')).toBe(true);
  });

  it('hides cancellation while the credential response is pending', async () => {
    const pending = deferred<LoginFlowState>();
    harness.respondPromise = pending.promise;
    const renderer = mount();
    await clickAsync(renderer, 'auth-start');
    const input = renderer.root.findByProps({ 'data-auth-secret': true });
    act(() => { input.props.onChange({ target: { value: 'sentinel-web-secret' } }); });
    click(renderer, 'auth-submit');

    expect(renderer.root.findAllByProps({ 'data-action': 'auth-cancel' })).toHaveLength(0);
    await act(async () => { pending.resolve(state('running')); await pending.promise; });
  });

  it('does not offer cancellation after the credential handoff begins', async () => {
    harness.respondState = state('running');
    const renderer = mount();
    await clickAsync(renderer, 'auth-start');
    const input = renderer.root.findByProps({ 'data-auth-secret': true });
    act(() => { input.props.onChange({ target: { value: 'sentinel-web-secret' } }); });
    await clickAsync(renderer, 'auth-submit');

    expect(renderer.root.findAllByProps({ 'data-action': 'auth-cancel' })).toHaveLength(0);
  });

  it.each(NOTICE_CASES)('renders %s notice metadata without a pending input', async (notice, kind) => {
    harness.startState = state('running', { authType: 'oauth', notice });
    harness.queryState = harness.startState;
    const renderer = mount();
    await clickAsync(renderer, 'auth-start');

    expect(renderer.root.findByProps({ 'data-auth-notice': kind })).toBeTruthy();
    expect(renderer.root.findAllByProps({ 'data-auth-secret': true })).toHaveLength(0);
    const html = JSON.stringify(renderer.toJSON());
    if (kind === 'info') {
      expect(renderer.root.findByProps({
        'data-auth-external-url': 'https://help.example.test',
      })).toBeTruthy();
    }
    if (kind === 'auth_url') {
      expect(renderer.root.findByProps({
        'data-auth-external-url': 'https://login.example.test/authorize?state=fixture',
      })).toBeTruthy();
    }
    if (kind === 'device_code') {
      expect(html).toContain('ABCD-EFGH');
      expect(html).toContain('600');
      expect(html.match(/Open verification page/g)).toHaveLength(1);
      expect(renderer.root.findByProps({
        'data-auth-external-url': 'https://verify.example.test',
      })).toBeTruthy();
    }
    if (kind === 'progress') {
      expect(renderer.root.findAllByProps({ 'data-auth-progress': true })).toHaveLength(1);
    }
  });

  it('cancels the active flow and stops polling terminal state', async () => {
    const renderer = mount();
    await clickAsync(renderer, 'auth-start');
    await clickAsync(renderer, 'auth-cancel');

    expect(harness.cancelCalls).toEqual([{ flowId: 'flow-web' }]);
    const latest = harness.flowQueries.at(-1);
    expect(typeof latest.refetchInterval === 'function' || latest.refetchInterval === false).toBe(true);
  });

  it('resets a terminal flow when the modal closes and reopens', async () => {
    const renderer = mount();
    await clickAsync(renderer, 'auth-start');
    act(() => { renderer.update(<LangProvider><LoginFlowModal open={false} onClose={() => {}} /></LangProvider>); });
    act(() => { renderer.update(<LangProvider><LoginFlowModal open onClose={() => {}} /></LangProvider>); });

    expect(renderer.root.findByProps({ 'data-action': 'auth-start' })).toBeTruthy();
  });

  it('ignores a start response that settles after close and reopen', async () => {
    const pending = deferred<LoginFlowState>();
    harness.startPromise = pending.promise;
    const renderer = mount();
    click(renderer, 'auth-start');
    act(() => { renderer.update(<LangProvider><LoginFlowModal open={false} onClose={() => {}} /></LangProvider>); });
    act(() => { renderer.update(<LangProvider><LoginFlowModal open onClose={() => {}} /></LangProvider>); });
    await act(async () => { pending.resolve(state('prompt')); await pending.promise; });

    expect(renderer.root.findByProps({ 'data-action': 'auth-start' })).toBeTruthy();
  });

  it('shows a safe tRPC start failure in the selection view', async () => {
    harness.startError = 'Login is already active on another surface.';
    const renderer = mount();
    await clickAsync(renderer, 'auth-start');

    expect(renderer.root.findByProps({ role: 'alert' }).children.join('')).toBe(
      'A login flow is already active on another surface.',
    );
  });

  it('localizes a server-reported expired notice binding', async () => {
    harness.startError = 'Login flow not found or expired.';
    const renderer = mount({ target: NOTICE_TARGET });
    await act(async () => { await Promise.resolve(); });

    expect(renderer.root.findByProps({ role: 'alert' }).children.join('')).toContain(
      'This login flow expired',
    );
  });

  it('renders an expired error when flowState returns null', async () => {
    harness.queryState = null;
    const renderer = mount();
    await clickAsync(renderer, 'auth-start');

    expect(renderer.root.findByProps({ 'data-auth-flow-step': 'failed' })).toBeTruthy();
  });
});
