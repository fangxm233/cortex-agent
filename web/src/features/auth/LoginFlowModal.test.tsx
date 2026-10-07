import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthNoticeAction, LoginFlowState } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';

type Prompt = NonNullable<LoginFlowState['pendingPrompt']>;
type Respond = { flowId: string; value: string; promptId?: number };

const harness = vi.hoisted(() => ({
  startCalls: [] as unknown[],
  respondCalls: [] as Respond[],
  cancelCalls: [] as unknown[],
  pollCalls: [] as string[],
  invalidations: [] as Array<{ __kind: string }>,
  onStart: null as null | ((input: unknown) => Promise<LoginFlowState> | LoginFlowState),
  onRespond: null as null | ((input: Respond) => Promise<LoginFlowState> | LoginFlowState),
  onPoll: null as null | ((flowId: string) => Promise<LoginFlowState | null> | LoginFlowState | null),
  modalProps: null as any,
  mobile: false,
  client: null as any,
}));

vi.mock('@/design', () => ({
  Modal: (props: any) => {
    harness.modalProps = props;
    return props.open
      ? <div data-auth-modal="true"><h1>{props.title}</h1>{props.children}<footer>{props.footer}</footer></div>
      : null;
  },
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  Select: ({ options, value, ...props }: any) => (
    <div data-select-value={String(value)} {...props}>
      {options.map((option: any) => <span key={option.value}>{option.label}</span>)}
    </div>
  ),
  MBottomSheet: ({ children, dimDismiss }: any) => <div data-mobile-bottom-sheet data-dim-dismiss={String(dimDismiss)}>{children}</div>,
}));

vi.mock('@/lib/use-mobile-layout', () => ({ useMobileLayout: () => harness.mobile }));
vi.mock('@/lib/external-navigation', () => ({ openExternalUrl: async () => {} }));

vi.mock('@/lib/trpc', () => {
  const query = (kind: string) => ({
    queryOptions: (input: unknown) => ({ __kind: kind, input }),
    queryFilter: () => ({ __kind: kind }),
  });
  harness.client = {
    auth: {
      startLogin: { mutate: async (input: unknown) => { harness.startCalls.push(input); return harness.onStart!(input); } },
      respondPrompt: { mutate: async (input: Respond) => { harness.respondCalls.push(input); return harness.onRespond!(input); } },
      cancelFlow: { mutate: async (input: unknown) => { harness.cancelCalls.push(input); return null; } },
      flowState: { query: async ({ flowId }: { flowId: string }) => { harness.pollCalls.push(flowId); return harness.onPoll!(flowId); } },
    },
  };
  return {
    useTRPCClient: () => harness.client,
    useTRPC: () => ({ auth: { status: query('auth.status'), flowState: query('auth.flowState') }, config: { get: query('config.get') } }),
    trpcErrorCode: (error: any) => error?.data?.code ?? null,
  };
});

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tanstack/react-query')>(),
  useQuery: (options: any) => ({ data: options.__kind === 'auth.status' ? AUTH_STATUS : undefined }),
  useQueryClient: () => ({ invalidateQueries: (filter: { __kind: string }) => { harness.invalidations.push(filter); } }),
}));

import { ChatNotice } from '@/features/session/transcript/ChatNotice';
import { LoginFlowModal, type LoginFlowModalProps, type LoginFlowTarget } from './LoginFlowModal';
import { LoginFlowProvider } from './LoginFlowProvider';

const AUTH_STATUS = {
  generatedAt: '2030-01-01T00:00:00.000Z',
  accounts: [
    { backend: 'pi', provider: 'openai-codex', label: 'OpenAI Codex', capabilities: ['oauth'] },
    { backend: 'pi', provider: 'cloudflare-ai-gateway', label: 'Cloudflare AI Gateway', capabilities: ['api_key'] },
  ],
  piRuntime: { available: true, version: 'test', entry: null, error: null },
};

const DEEPSEEK: LoginFlowTarget = { backend: 'pi', provider: 'deepseek', authType: 'api_key', label: 'DeepSeek' };
const CODEX: LoginFlowTarget = { backend: 'pi', provider: 'openai-codex', authType: 'oauth' };

function snapshot(revision: number, overrides: Partial<LoginFlowState> = {}): LoginFlowState {
  return {
    flowId: 'flow-1', revision, backend: 'pi', provider: 'deepseek', authType: 'api_key',
    step: 'running', pendingPrompt: null, notice: null, channel: null, sessionId: null,
    createdAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:30:00.000Z',
    outcome: null, error: null, errorCode: null, ...overrides,
  };
}

function prompt(revision: number, value: Omit<Prompt, 'id'>, overrides: Partial<LoginFlowState> = {}): LoginFlowState {
  return snapshot(revision, { step: 'prompt', pendingPrompt: { id: revision, ...value }, ...overrides });
}

/**
 * A server that walks a list of prompts the way the real coordinator does: an answer returns a
 * `running` snapshot, and the next prompt (or the final state) only shows up on a later poll.
 */
function scriptedServer(steps: Array<{ prompt: Omit<Prompt, 'id'>; notice?: LoginFlowState['notice'] }>, final: Partial<LoginFlowState>) {
  let revision = 1;
  let index = 0;
  let advancing = false;
  let current = prompt(revision, steps[0]!.prompt, { notice: steps[0]!.notice ?? null });
  harness.onStart = () => current;
  harness.onRespond = (input) => {
    if (input.promptId !== current.pendingPrompt?.id) throw new Error('stale prompt');
    revision += 1; index += 1; advancing = true;
    current = snapshot(revision);
    return current;
  };
  harness.onPoll = () => {
    if (!advancing) return current;
    advancing = false;
    revision += 1;
    const step = steps[index];
    current = step ? prompt(revision, step.prompt, { notice: step.notice ?? null }) : snapshot(revision, final);
    return current;
  };
}

function mount(props: Partial<LoginFlowModalProps> = {}): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<LangProvider><LoginFlowModal open onClose={() => {}} target={DEEPSEEK} {...props} /></LangProvider>);
  });
  return renderer;
}

async function flush(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

async function poll(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
}

function find(renderer: ReactTestRenderer, props: Record<string, unknown>): ReactTestInstance {
  return renderer.root.findByProps(props);
}

function flowStep(renderer: ReactTestRenderer): string {
  return renderer.root.findAll(node => node.props['data-auth-flow-step'] !== undefined)[0]!.props['data-auth-flow-step'];
}

function text(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

/** Only what a user reads: text nodes, not data attributes. */
function visibleText(renderer: ReactTestRenderer): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') parts.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object' && 'children' in node) walk((node as { children: unknown }).children);
  };
  walk(renderer.toJSON());
  return parts.join(' ');
}

function type(renderer: ReactTestRenderer, value: string): void {
  const input = renderer.root.findAll(node => node.type === 'input' && node.props['data-auth-input'])[0]!;
  act(() => { input.props.onChange({ target: { value } }); });
}

async function submit(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => { find(renderer, { 'data-action': 'auth-submit' }).props.onClick(); });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  harness.startCalls = [];
  harness.respondCalls = [];
  harness.cancelCalls = [];
  harness.pollCalls = [];
  harness.invalidations = [];
  harness.modalProps = null;
  harness.mobile = false;
  harness.onStart = () => prompt(1, { kind: 'secret', message: 'Enter DeepSeek API key' });
  harness.onRespond = () => snapshot(2);
  harness.onPoll = () => null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LoginFlowModal', () => {
  it('starts the target on open and shows the server prompt under a provider title', async () => {
    const renderer = mount();
    await flush();

    expect(harness.startCalls).toEqual([{ backend: 'pi', provider: 'deepseek', authType: 'api_key' }]);
    expect(find(renderer, { 'data-auth-title': true }).props.children).toBe('Log in to DeepSeek');
    expect(find(renderer, { 'data-auth-subtitle': true }).props.children).toBe('API key');
    expect(find(renderer, { 'data-auth-prompt-copy': true }).props.children).toBe('Enter DeepSeek API key');
    const input = find(renderer, { 'data-auth-input': 'secret' });
    expect(input.props.type).toBe('password');
    expect(find(renderer, { 'data-action': 'auth-submit' }).props.disabled).toBe(true);
    expect(visibleText(renderer)).not.toMatch(/\bPI\b|deepseek/);
  });

  it('walks a select prompt into the browser step and answers the manual code', async () => {
    const message = 'Complete login in your browser, or paste the authorization code / redirect URL here:';
    scriptedServer([
      { prompt: { kind: 'select', message: 'Select OpenAI Codex login method:', options: [
        { id: 'browser', label: 'Browser login (default)' }, { id: 'device', label: 'Device code login (headless)' },
      ] } },
      {
        prompt: { kind: 'manual_code', message, placeholder: 'http://localhost:1455/auth/callback' },
        notice: { kind: 'auth_url', url: 'https://auth.openai.com/authorize?x=1', instructions: 'A browser window should open.' },
      },
    ], { step: 'done', outcome: { provider: 'openai-codex', authType: 'oauth', expiresAt: null } });
    const renderer = mount({ target: CODEX });
    await flush();

    expect(find(renderer, { 'data-auth-title': true }).props.children).toBe('Log in to OpenAI Codex');
    expect(find(renderer, { 'data-auth-select': true }).props.value).toBe('browser');
    await submit(renderer);
    expect(harness.respondCalls).toEqual([{ flowId: 'flow-1', value: 'browser', promptId: 1 }]);
    expect(flowStep(renderer)).toBe('running');
    expect(find(renderer, { 'data-action': 'auth-cancel' })).toBeTruthy();

    await poll();
    expect(flowStep(renderer)).toBe('prompt');
    expect(find(renderer, { 'data-auth-open-step': true })).toBeTruthy();
    expect(find(renderer, { 'data-auth-code-step': true })).toBeTruthy();
    expect(find(renderer, { 'data-auth-prompt-copy': true }).props.children).toBe(message);
    expect(find(renderer, { 'data-auth-input': 'manual_code' }).props.placeholder).toBe('http://localhost:1455/auth/callback');
    expect(find(renderer, { 'data-action': 'auth-copy-url' })).toBeTruthy();

    type(renderer, 'http://localhost:1455/auth/callback?code=abc&state=s');
    await submit(renderer);
    expect(harness.respondCalls[1]).toEqual({ flowId: 'flow-1', value: 'http://localhost:1455/auth/callback?code=abc&state=s', promptId: 3 });
    await poll();
    expect(flowStep(renderer)).toBe('done');
    expect(text(renderer)).toContain('Logged in to OpenAI Codex.');
  });

  it('answers a secret then two text prompts in turn', async () => {
    scriptedServer([
      { prompt: { kind: 'secret', message: 'Enter Cloudflare API key' } },
      { prompt: { kind: 'text', message: 'Enter Cloudflare account ID' } },
      { prompt: { kind: 'text', message: 'Enter Cloudflare AI Gateway ID' } },
    ], { step: 'done', outcome: { provider: 'cloudflare-ai-gateway', authType: 'api_key', expiresAt: null } });
    const renderer = mount({ target: { backend: 'pi', provider: 'cloudflare-ai-gateway', authType: 'api_key' } });
    await flush();

    for (const [index, message] of ['Enter Cloudflare API key', 'Enter Cloudflare account ID', 'Enter Cloudflare AI Gateway ID'].entries()) {
      expect(find(renderer, { 'data-auth-prompt-copy': true }).props.children).toBe(message);
      type(renderer, `value-${index}`);
      await submit(renderer);
      await poll();
    }
    expect(harness.respondCalls.map(call => [call.value, call.promptId])).toEqual([['value-0', 1], ['value-1', 3], ['value-2', 5]]);
    expect(flowStep(renderer)).toBe('done');
  });

  it('submits an empty answer to a text prompt but not to a secret', async () => {
    harness.onStart = () => prompt(1, { kind: 'text', message: 'Configure AWS credentials, then press Enter to continue' });
    const renderer = mount({ target: { backend: 'pi', provider: 'amazon-bedrock', authType: 'api_key', label: 'Amazon Bedrock' } });
    await flush();

    expect(find(renderer, { 'data-action': 'auth-submit' }).props.disabled).toBe(false);
    await act(async () => {
      find(renderer, { 'data-auth-input': 'text' }).props.onKeyDown({ key: 'Enter', nativeEvent: {}, preventDefault: () => {} });
    });
    await flush();
    expect(harness.respondCalls).toEqual([{ flowId: 'flow-1', value: '', promptId: 1 }]);
  });

  it('keeps the newest revision when an older snapshot arrives late', async () => {
    const polls = [
      snapshot(3, { notice: { kind: 'progress', message: 'Exchanging the code' } }),
      prompt(2, { kind: 'secret', message: 'Enter DeepSeek API key' }),
    ];
    harness.onPoll = () => polls.shift() ?? null;
    const renderer = mount();
    await flush();
    await poll();
    expect(flowStep(renderer)).toBe('notice');
    await poll();
    expect(flowStep(renderer)).toBe('notice');
    expect(text(renderer)).toContain('Exchanging the code');
  });

  it('drops and cancels a start that settles after the dialog closed', async () => {
    let settle!: (state: LoginFlowState) => void;
    harness.onStart = () => new Promise(resolve => { settle = resolve; });
    const renderer = mount();
    act(() => { renderer.update(<LangProvider><LoginFlowModal open={false} onClose={() => {}} target={DEEPSEEK} /></LangProvider>); });
    await act(async () => { settle(prompt(1, { kind: 'secret', message: 'late' })); await vi.advanceTimersByTimeAsync(0); });

    expect(harness.cancelCalls).toEqual([{ flowId: 'flow-1' }]);
    expect(text(renderer)).not.toContain('late');
  });

  it('cancels an unfinished flow when the dialog closes, and keeps it open on an outside click', async () => {
    const renderer = mount();
    await flush();
    const outside = { preventDefault: vi.fn() };
    harness.modalProps.onPointerDownOutside(outside);
    expect(outside.preventDefault).toHaveBeenCalled();

    act(() => { renderer.update(<LangProvider><LoginFlowModal open={false} onClose={() => {}} target={DEEPSEEK} /></LangProvider>); });
    expect(harness.cancelCalls).toEqual([{ flowId: 'flow-1' }]);
  });

  it('closes from Cancel and lets an outside click close a finished flow', async () => {
    const onClose = vi.fn();
    harness.onStart = () => snapshot(1, { step: 'done', outcome: { provider: 'deepseek', authType: 'api_key', expiresAt: null } });
    const renderer = mount({ onClose });
    await flush();
    const outside = { preventDefault: vi.fn() };
    harness.modalProps.onPointerDownOutside(outside);
    expect(outside.preventDefault).not.toHaveBeenCalled();
    act(() => { find(renderer, { 'data-action': 'auth-done' }).props.onClick(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the upstream reason of a failure and retries with a new flow', async () => {
    harness.onStart = () => snapshot(1, { step: 'failed', error: 'OpenAI Codex login failed: State mismatch', errorCode: 'login_failed' });
    const renderer = mount({ target: CODEX });
    await flush();

    expect(flowStep(renderer)).toBe('failed');
    expect(find(renderer, { 'data-auth-error-detail': true }).props.children).toBe('OpenAI Codex login failed: State mismatch');
    harness.onStart = () => prompt(1, { kind: 'manual_code', message: 'Paste code' }, { flowId: 'flow-2' });
    await act(async () => { find(renderer, { 'data-action': 'auth-retry' }).props.onClick(); });
    await flush();
    expect(harness.startCalls).toHaveLength(2);
    expect(flowStep(renderer)).toBe('prompt');
  });

  it('does not carry a typed answer into the retried flow, whose prompt ids start over', async () => {
    harness.onStart = () => prompt(1, { kind: 'manual_code', message: 'Paste code' });
    harness.onRespond = () => snapshot(2, { step: 'failed', error: 'Token exchange failed', errorCode: 'login_failed' });
    const renderer = mount({ target: CODEX });
    await flush();
    type(renderer, 'expired-code');
    await submit(renderer);
    expect(flowStep(renderer)).toBe('failed');

    harness.onStart = () => prompt(1, { kind: 'manual_code', message: 'Paste code' }, { flowId: 'flow-2' });
    await act(async () => { find(renderer, { 'data-action': 'auth-retry' }).props.onClick(); });
    await flush();
    const input = renderer.root.findAll(node => node.type === 'input' && node.props['data-auth-input'])[0]!;
    expect(input.props.value).toBe('');
  });

  it('shows a refused start with Retry', async () => {
    harness.onStart = () => { throw new Error('The previous login is still completing.'); };
    const renderer = mount();
    await flush();

    expect(find(renderer, { 'data-auth-error-detail': true }).props.children).toBe('The previous login is still completing.');
    expect(find(renderer, { 'data-action': 'auth-retry' })).toBeTruthy();
  });

  it('refreshes accounts and config once when the login is done', async () => {
    const onDone = vi.fn();
    harness.onRespond = () => snapshot(2, { step: 'done', outcome: { provider: 'deepseek', authType: 'api_key', expiresAt: null } });
    const renderer = mount({ onDone });
    await flush();
    type(renderer, 'sk-test');
    await submit(renderer);
    await poll();

    expect(flowStep(renderer)).toBe('done');
    expect(text(renderer)).not.toContain('sk-test');
    expect(harness.invalidations.map(entry => entry.__kind).sort()).toEqual(['auth.status', 'config.get']);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(harness.pollCalls).toHaveLength(0);
  });

  it('turns a flow the server no longer knows into an expired failure', async () => {
    harness.onPoll = () => null;
    const renderer = mount();
    await flush();
    await poll();

    expect(flowStep(renderer)).toBe('failed');
    expect(text(renderer)).toContain('This login expired. Try again.');
  });

  it('counts a device code down from when it was shown', async () => {
    harness.onStart = () => snapshot(1, { notice: { kind: 'device_code', userCode: 'A1B2-C3D4', verificationUri: 'https://github.com/login/device', expiresInSeconds: 900 } });
    harness.onPoll = () => snapshot(1, { notice: { kind: 'device_code', userCode: 'A1B2-C3D4', verificationUri: 'https://github.com/login/device', expiresInSeconds: 900 } });
    const renderer = mount({ target: { backend: 'pi', provider: 'github-copilot', authType: 'oauth', label: 'GitHub Copilot' } });
    await flush();
    expect(text(renderer)).toContain('expires in 15:00');
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    expect(text(renderer)).toContain('expires in 13:59');
    expect(find(renderer, { 'data-action': 'auth-copy-code' })).toBeTruthy();
  });

  it('keeps a mobile sheet open on a dim tap while the flow runs', async () => {
    harness.mobile = true;
    const renderer = mount();
    await flush();
    expect(find(renderer, { 'data-mobile-bottom-sheet': true }).props['data-dim-dismiss']).toBe('false');
  });
});

describe('LoginFlowProvider', () => {
  const NOTICE: AuthNoticeAction = {
    kind: 'auth-login', noticeId: 'notice-1', backend: 'pi', provider: 'openai-codex', authType: 'oauth',
  };

  it('starts a chat-notice login with its notice id and the provider label', async () => {
    harness.onStart = () => prompt(1, { kind: 'manual_code', message: 'Paste code' }, { provider: 'openai-codex', authType: 'oauth' });
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<LangProvider><LoginFlowProvider>
        <ChatNotice level="error" text="Authentication expired" authAction={NOTICE} />
      </LoginFlowProvider></LangProvider>);
    });
    act(() => { find(renderer, { 'data-auth-notice-action': true }).props.onClick(); });
    await flush();

    expect(harness.startCalls).toEqual([{ backend: 'pi', provider: 'openai-codex', authType: 'oauth', noticeId: 'notice-1' }]);
    expect(find(renderer, { 'data-auth-title': true }).props.children).toBe('Log in to OpenAI Codex');
    expect(harness.modalProps.layer).toBe('nested');
  });
});
