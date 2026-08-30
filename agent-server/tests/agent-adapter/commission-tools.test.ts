// input:  buildSpawnArgs / withoutCommissionTools / PI bridge env, with and without commission tools
// output: pinned additivity of the commission tools and their invisibility everywhere else
// pos:    tests for the standalone commission-creation tools (DR-0037 v3)
// >>> If I am updated, update CORTEX.md <<<
import { describe, it, expect } from 'vitest';
import { buildSpawnArgs, type ClaudeSpawnOptions } from '../../src/agent-adapter/claude/spawn-args.js';
import { MCP_TOOL_ALLOWLIST_ENV, withoutCommissionTools } from '../../src/core/mcp-tool-gate.js';
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
  it('hides the commission tools from an ordinary user session', () => {
    const tools = toolsOf({ isUserInitiated: true });
    for (const tool of PLAN) expect(tools).toContain(tool);
    for (const tool of COMMISSION) expect(tools).not.toContain(tool);
  });

  it('adds the commission tools without taking the plan tools away', () => {
    // v2 swapped the two pairs; they are now independent, so a session drafting a contract can
    // still use ordinary plan mode for the implementation work inside it.
    const tools = toolsOf({ isUserInitiated: true, commissionTools: true });
    for (const tool of COMMISSION) expect(tools).toContain(tool);
    for (const tool of PLAN) expect(tools).toContain(tool);
    expect(tools).toContain(`${P}cortex_ask_user`);
  });

  it('adds them on top of the TUI baseline too', () => {
    const tools = toolsOf({ isUserInitiated: true, mode: 'tui', commissionTools: true });
    for (const tool of [...PLAN, ...COMMISSION]) expect(tools).toContain(tool);
  });

  it('leaves a non-user-initiated session with no bridge tools at all', () => {
    const tools = toolsOf({ commissionTools: true });
    for (const tool of [...PLAN, ...COMMISSION]) expect(tools).not.toContain(tool);
  });

  it('refuses them outside a direct composition', () => {
    const tools = toolsOf({
      isUserInitiated: true, mcpComposition: 'thread-control', commissionTools: true,
    });
    for (const tool of [...PLAN, ...COMMISSION]) expect(tools).not.toContain(tool);
  });

  it('does not make an ordinary spawn depend on the MCP config file contents', () => {
    // v2 synthesized a gated MCP config here, which meant reading the daemon-generated config at
    // spawn time; a bare test home has none, and 61 tests failed on it.
    const args = buildSpawnArgs(base({ isUserInitiated: true, commissionTools: true }));
    expect(args).toContain('--tools');
  });
});

describe('withoutCommissionTools', () => {
  const bundles = ['cortex-core', 'cortex-interaction-bridge'];

  it('synthesizes an allowlist from the bundles when the caller declared none', () => {
    // The gate is fail-open on an absent allowlist, so "exclude X" has to be spelled out as
    // "allow everything except X" — withholding the list would allow X.
    const allowed = withoutCommissionTools(undefined, bundles);
    expect(allowed).toContain('cortex_plan_exit');
    expect(allowed).toContain('current_time');
    expect(allowed).not.toContain('cortex_commission_start');
    expect(allowed).not.toContain('cortex_commission_submit');
  });

  it('narrows a declared allowlist instead of widening it', () => {
    const allowed = withoutCommissionTools(['current_time', 'cortex_commission_submit'], bundles);
    expect(allowed).toEqual(['current_time']);
  });
});

describe('PI bundled-server env gate', () => {
  async function coreEnv(overrides: Record<string, string>): Promise<Record<string, string>> {
    const { buildServerStates } = await import('../../src/agent-adapter/pi/mcp-bridge.js');
    const states = buildServerStates({
      CORTEX_PI_MCP_COMPOSITION: 'direct',
      CORTEX_PI_INTERACTION_BRIDGE: '1',
      ...overrides,
    } as NodeJS.ProcessEnv);
    const core = states.find((s) => s.name === 'core');
    if (!core || core.config.type !== 'stdio') throw new Error('no core stdio server');
    return core.config.env as Record<string, string>;
  }

  it('leaves a commission session ungated so it can reach both tool sets', async () => {
    const env = await coreEnv({ CORTEX_PI_COMMISSION_TOOLS: '1' });
    expect(env[MCP_TOOL_ALLOWLIST_ENV]).toBeUndefined();
  });

  it('gates an ordinary session, because PI has no --tools equivalent', async () => {
    const env = await coreEnv({});
    const allowed = JSON.parse(env[MCP_TOOL_ALLOWLIST_ENV]) as string[];
    expect(allowed).toContain('cortex_plan_exit');
    expect(allowed).not.toContain('cortex_commission_start');
    expect(allowed).not.toContain('cortex_commission_submit');
  });
});

describe('cortex_commission_start', () => {
  const deps = (sessionName: string | null): InteractionToolDeps => ({
    channel: 'web:x', sessionId: 's', sessionName, threadId: null,
    webhookBaseUrl: 'http://127.0.0.1:1', httpPost: async () => ({ status: 200, body: {} }),
  });

  it('names the draft directory the server already created for this session', () => {
    const text = runCommissionStart({}, deps('cortex-a1b2')).content[0].text;
    expect(text).toContain('commissions/_draft-cortex-a1b2/');
    expect(text).toContain('cortex_commission_submit');
  });

  it('carries the whole creation protocol, since the skill no longer covers it', () => {
    const text = runCommissionStart({}, deps('cortex-a1b2')).content[0].text;
    for (const section of [
      '## Goal (user\'s words)', '## Inferences', '## Acceptance criteria',
      '## Out of scope', '## Gates', '## Revisions',
    ]) {
      expect(text).toContain(section);
    }
    // The whole feature is English-only: no Chinese leaks into anything the agent reads.
    expect(text).not.toMatch(/[\u4e00-\u9fff]/);
    expect(text).toContain('Depth-first');
    expect(text).toContain('cortex_ask_user');
  });

  it('says nothing about plan mode being replaced — the two are unrelated now', () => {
    const text = runCommissionStart({}, deps('cortex-a1b2')).content[0].text;
    expect(text).not.toContain('cortex_plan_exit');
    expect(text).not.toContain('cortex_plan_enter');
    expect(text).not.toContain('plan mode');
  });

  it('degrades to a described location rather than a wrong path when the name is missing', () => {
    const text = runCommissionStart({}, deps(null)).content[0].text;
    expect(text).toContain('commissions/_draft-*');
    expect(text).not.toContain('_draft-null');
  });

  it('records the optional reasoning', () => {
    const text = runCommissionStart({ reasoning: 'why' }, deps('cortex-a1b2')).content[0].text;
    expect(text).toContain('Reasoning recorded: why');
  });
});
