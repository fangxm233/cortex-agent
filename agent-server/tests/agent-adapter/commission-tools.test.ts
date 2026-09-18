import { describe, it, expect } from 'vitest';
import { buildSpawnArgs, type ClaudeSpawnOptions } from '../../src/agent-adapter/claude/spawn-args.js';
import { MCP_TOOL_ALLOWLIST_ENV } from '../../src/core/mcp-tool-gate.js';
import { runCommissionStart } from '../../src/domain/mcp/tools/commission-tools.js';
import type { InteractionToolDeps } from '../../src/domain/mcp/tools/interaction-plan.js';

const P = 'mcp__cortex-core__';
const PLAN = [`${P}cortex_plan_enter`, `${P}cortex_plan_exit`];
const COMMISSION = [`${P}cortex_commission_start`, `${P}cortex_commission_submit`];

function base(overrides: Partial<ClaudeSpawnOptions>): ClaudeSpawnOptions {
  return {
    tools: null, systemPrompt: null, appendSystemPrompt: null, model: null,
    claudeAgent: null, pluginDirs: null, outputStyle: null,
    needsResume: false, sessionId: 'uuid-commission', ...overrides,
  };
}

function toolsOf(options: Partial<ClaudeSpawnOptions>): string[] {
  const args = buildSpawnArgs(base(options));
  return args[args.indexOf('--tools') + 1].split(',');
}

describe('commission tools — Claude --tools', () => {
  it('lists the commission tools for every direct user session', () => {
    // DR-0037 v4. v3 listed them only while a contract was being drafted, on the theory that
    // `--tools` decides what a spawn can call. It does not: the flag filters Claude's BUILT-IN set,
    // so the MCP pair was callable from every direct session whatever this list said. The list now
    // states the truth, and a submit from a session that never entered the mode is refused by
    // commission-finalize instead.
    const tools = toolsOf({ isUserInitiated: true });
    for (const tool of [...PLAN, ...COMMISSION]) expect(tools).toContain(tool);
    expect(tools).toContain(`${P}cortex_ask_user`);
  });

  it('leaves a non-user-initiated session with no bridge tools at all', () => {
    const tools = toolsOf({});
    for (const tool of [...PLAN, ...COMMISSION]) expect(tools).not.toContain(tool);
  });

  it('refuses them outside a direct composition', () => {
    const tools = toolsOf({ isUserInitiated: true, mcpComposition: 'thread-control' });
    for (const tool of [...PLAN, ...COMMISSION]) expect(tools).not.toContain(tool);
  });

  it('does not make an ordinary spawn depend on the MCP config file contents', () => {
    // v2 synthesized a gated MCP config here, which meant reading the daemon-generated config at
    // spawn time; a bare test home has none, and 61 tests failed on it.
    const args = buildSpawnArgs(base({ isUserInitiated: true }));
    expect(args).toContain('--tools');
    expect(args.some((a) => a.includes('mcp-tool-gates'))).toBe(false);
  });
});

describe('PI bundled core tool-context env gate', () => {
  // The bundled core server now runs in-process; its tool context is built from the env the
  // bridge attaches to the `core` state, so the gate is read from `source.env`.
  async function coreEnv(overrides: Record<string, string>): Promise<Record<string, string>> {
    const { buildServerStates } = await import('../../src/agent-adapter/pi/mcp-bridge.js');
    const states = buildServerStates({
      CORTEX_PI_MCP_COMPOSITION: 'direct',
      CORTEX_PI_INTERACTION_BRIDGE: '1',
      ...overrides,
    } as NodeJS.ProcessEnv);
    const core = states.find((s) => s.name === 'core');
    if (!core || core.source.kind !== 'bundled') throw new Error('no bundled core server');
    return core.source.env;
  }

  it('keeps the commission pair for every direct session, matching Claude', async () => {
    // PI used to be the only backend where hiding them actually worked, which made the same
    // feature mean two different things per backend. v4 drops the exclusion on both.
    const allowed = JSON.parse((await coreEnv({}))[MCP_TOOL_ALLOWLIST_ENV]) as string[];
    expect(allowed).toContain('cortex_commission_start');
    expect(allowed).toContain('cortex_commission_submit');
    expect(allowed).toContain('cortex_plan_exit');
  });

  it('still withholds the MCP delegation pair, which PI supplies natively', async () => {
    const allowed = JSON.parse((await coreEnv({}))[MCP_TOOL_ALLOWLIST_ENV]) as string[];
    expect(allowed).not.toContain('agent');
    expect(allowed).not.toContain('agent_stop');
  });
});

describe('cortex_commission_start', () => {
  interface Posted { url: string; body: any }

  function deps(
    over: { sessionId?: string | null; reply?: any; posted?: Posted[] } = {},
  ): InteractionToolDeps {
    return {
      channel: 'web:x',
      sessionId: over.sessionId === undefined ? 's-1' : over.sessionId,
      sessionName: 'cortex-a1b2',
      threadId: null,
      webhookBaseUrl: 'http://127.0.0.1:1',
      httpPost: async (url, body) => {
        over.posted?.push({ url, body });
        return { status: 200, body: over.reply ?? { ok: true, dir: '/ctx/proj/commissions/_draft-cortex-a1b2', draftDir: '_draft-cortex-a1b2' } };
      },
    };
  }

  const textOf = async (d: InteractionToolDeps, args: { reasoning?: string } = {}) =>
    (await runCommissionStart(args, d)).content[0].text;

  it('enters the mode through the daemon and reports the directory it made', async () => {
    // v3 only PRINTED a path the session-create path had already made; the agent could not enter
    // the mode itself. v4 makes the tool the entry, so the directory and the registry flag are its
    // work — done over the loopback webhook, since the MCP process holds no registry.
    const posted: Posted[] = [];
    const text = await textOf(deps({ posted }));
    expect(posted[0].url).toBe('http://127.0.0.1:1/hook/commission-start');
    expect(posted[0].body).toMatchObject({ sessionId: 's-1', channel: 'web:x' });
    expect(text).toContain('/ctx/proj/commissions/_draft-cortex-a1b2');
    expect(text).toContain('cortex_commission_submit');
  });

  it('surfaces a refusal from the daemon instead of handing out the protocol', async () => {
    const result = await runCommissionStart({}, deps({
      reply: { error: 'this session is already bound to commission dc44f400 — open a new session for another one' },
    }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already bound to commission dc44f400');
    expect(result.content[0].text).not.toContain('Phase 1 — drill');
  });

  it('refuses without a session id rather than creating a stray directory', async () => {
    const result = await runCommissionStart({}, deps({ sessionId: null }));
    expect(result.isError).toBe(true);
  });
});
