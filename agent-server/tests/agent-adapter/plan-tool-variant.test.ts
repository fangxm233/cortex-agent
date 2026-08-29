// input:  buildSpawnArgs / applyPlanToolVariant / PI bridge env, in both plan-tool variants
// output: pinned exclusivity of the commission plan tools vs the ordinary ones
// pos:    tests for the commission-mode tool swap (DR-0037 v2)
// >>> If I am updated, update CORTEX.md <<<
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { buildSpawnArgs, type ClaudeSpawnOptions } from '../../src/agent-adapter/claude/spawn-args.js';
import { MCP_CONFIG } from '../../src/agent-adapter/claude/defaults.js';
import { buildFullConfig } from '../../src/core/config-generator.js';
import { applyPlanToolVariant, MCP_TOOL_ALLOWLIST_ENV } from '../../src/core/mcp-tool-gate.js';
import { runCommissionPlanEnter } from '../../src/domain/mcp/tools/commission-plan.js';
import type { InteractionToolDeps } from '../../src/domain/mcp/tools/interaction-plan.js';

const P = 'mcp__cortex-core__';
const STANDARD = [`${P}cortex_plan_enter`, `${P}cortex_plan_exit`];
const COMMISSION = [`${P}cortex_commission_plan_enter`, `${P}cortex_commission_plan_exit`];

function base(overrides: Partial<ClaudeSpawnOptions>): ClaudeSpawnOptions {
  return {
    tools: null, systemPrompt: null, appendSystemPrompt: null, model: null,
    claudeAgent: null, pluginDirs: null, outputStyle: null,
    needsResume: false, sessionId: 'uuid-variant', ...overrides,
  };
}

function toolsOf(options: Partial<ClaudeSpawnOptions>): string[] {
  const args = buildSpawnArgs(base(options));
  return args[args.indexOf('--tools') + 1].split(',');
}

/** A commission spawn materializes a gated MCP config, which means it READS the base config the
 *  daemon normally generates at startup. A bare test home has none. */
beforeAll(() => {
  mkdirSync(path.dirname(MCP_CONFIG), { recursive: true });
  writeFileSync(MCP_CONFIG, JSON.stringify(buildFullConfig('/fixture/server-root')));
});

describe('plan tool variant — Claude --tools', () => {
  it('gives an ordinary user session the standard pair and hides the commission pair', () => {
    const tools = toolsOf({ isUserInitiated: true });
    for (const tool of STANDARD) expect(tools).toContain(tool);
    // v1 exposed the commission tools to every session; the swap is what takes them back.
    for (const tool of COMMISSION) expect(tools).not.toContain(tool);
  });

  it('swaps both plan tools for a commission session', () => {
    const tools = toolsOf({ isUserInitiated: true, planToolVariant: 'commission' });
    for (const tool of COMMISSION) expect(tools).toContain(tool);
    // The point of the mode: the only way out of plan mode names the commission.
    for (const tool of STANDARD) expect(tools).not.toContain(tool);
    expect(tools).toContain(`${P}cortex_ask_user`);
  });

  it('strips the standard pair baked into TUI_TOOLS rather than adding to it', () => {
    // TUI mode defaults to a tool list that already names the standard pair, so an additive
    // implementation would leave a commission session holding both.
    const tools = toolsOf({ isUserInitiated: true, mode: 'tui', planToolVariant: 'commission' });
    for (const tool of STANDARD) expect(tools).not.toContain(tool);
    for (const tool of COMMISSION) expect(tools).toContain(tool);
  });

  it('leaves a non-user-initiated session with no bridge tools at all', () => {
    const tools = toolsOf({ planToolVariant: 'commission' });
    for (const tool of [...STANDARD, ...COMMISSION]) expect(tools).not.toContain(tool);
  });

  it('refuses the swap outside a direct composition', () => {
    const tools = toolsOf({
      isUserInitiated: true, mcpComposition: 'thread-control', planToolVariant: 'commission',
    });
    for (const tool of [...STANDARD, ...COMMISSION]) expect(tools).not.toContain(tool);
  });
});

describe('applyPlanToolVariant', () => {
  const bundles = ['cortex-core', 'cortex-interaction-bridge'];

  it('synthesizes an allowlist from the bundles when the caller declared none', () => {
    // The gate is fail-open on an absent allowlist, so "exclude X" has to be spelled out as
    // "allow everything except X" — withholding the list would allow X.
    const allowed = applyPlanToolVariant(undefined, 'commission', bundles);
    expect(allowed).toContain('cortex_commission_plan_exit');
    expect(allowed).toContain('current_time');
    expect(allowed).not.toContain('cortex_plan_exit');
    expect(allowed).not.toContain('cortex_plan_enter');
  });

  it('narrows a declared allowlist instead of widening it', () => {
    const allowed = applyPlanToolVariant(['current_time', 'cortex_plan_exit'], 'commission', bundles);
    expect(allowed).toEqual(['current_time']);
  });

  it('drops the commission pair for the standard variant', () => {
    const allowed = applyPlanToolVariant(undefined, 'standard', bundles);
    expect(allowed).toContain('cortex_plan_exit');
    expect(allowed).not.toContain('cortex_commission_plan_exit');
    expect(allowed).not.toContain('cortex_commission_plan_enter');
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

  it('narrows the child allowlist for a commission session', async () => {
    // PI has no `--tools` equivalent for MCP tools, so this env var is the whole enforcement.
    const env = await coreEnv({ CORTEX_PI_PLAN_TOOL_VARIANT: 'commission' });
    const allowed = JSON.parse(env[MCP_TOOL_ALLOWLIST_ENV]) as string[];
    expect(allowed).toContain('cortex_commission_plan_exit');
    expect(allowed).not.toContain('cortex_plan_exit');
  });

  it('leaves an ordinary session ungated, exactly as before', async () => {
    const env = await coreEnv({ CORTEX_PI_PLAN_TOOL_VARIANT: 'standard' });
    expect(env[MCP_TOOL_ALLOWLIST_ENV]).toBeUndefined();
  });
});

describe('cortex_commission_plan_enter', () => {
  const deps = (sessionName: string | null): InteractionToolDeps => ({
    channel: 'web:x', sessionId: 's', sessionName, threadId: null,
    webhookBaseUrl: 'http://127.0.0.1:1', httpPost: async () => ({ status: 200, body: {} }),
  });

  it('names the draft directory the server already created for this session', () => {
    const text = runCommissionPlanEnter({}, deps('cortex-a1b2')).content[0].text;
    expect(text).toContain('commissions/_draft-cortex-a1b2/');
    expect(text).toContain('cortex_commission_plan_exit');
  });

  it('degrades to a described location rather than a wrong path when the name is missing', () => {
    const text = runCommissionPlanEnter({}, deps(null)).content[0].text;
    expect(text).toContain('commissions/_draft-*');
    expect(text).not.toContain('_draft-null');
  });

  it('records the optional reasoning', () => {
    const text = runCommissionPlanEnter({ reasoning: 'why' }, deps('cortex-a1b2')).content[0].text;
    expect(text).toContain('Reasoning recorded: why');
  });
});
