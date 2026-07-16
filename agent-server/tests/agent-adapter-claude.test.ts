// input:  Node test runner + agent-adapter/claude/* modules
// output: Claude CLI args / hooks / summarizer regression tests
// pos:    ClaudeAdapter pure-function spec-fidelity lock-down
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSpawnArgs, buildClaudeEnv } from '../src/agent-adapter/claude/spawn-args.js';
import {
  buildHooksSettings,
  POST_TOOL_USE_HOOKS,
  SESSION_START_HOOKS,
} from '../src/agent-adapter/claude/hooks-builder.js';
import { summarizeToolInput } from '../src/agent-adapter/claude/tool-summarizers.js';
import { DEFAULT_TOOLS, MCP_CONFIG, CORE_MCP_CONFIG, TUI_TOOLS, TUI_BRIDGE_TOOLS, TUI_MCP_CONFIG, FEISHU_MCP_CONFIG, WEB_MCP_CONFIG } from '../src/agent-adapter/claude/defaults.js';
import {
  extractAskUserQuestions,
  setActivePlanFile,
  clearActivePlanFile,
  getCurrentPlanFilePath,
} from '../src/agent-adapter/claude/event-parser.js';
import { _test as adapterTest, selectClaudeMode, recoverTuiOrphans } from '../src/agent-adapter/claude/adapter.js';
import type { TmuxExecResult } from '../src/agent-adapter/claude/tmux-control.js';

// --- buildSpawnArgs (pure) ---

test('buildSpawnArgs baseline — no optional flags', () => {
  const args = buildSpawnArgs({
    tools: null,
    systemPrompt: null,
    appendSystemPrompt: null,
    model: null,
    claudeAgent: null,
    pluginDirs: null,
    outputStyle: null,
    needsResume: false,
    sessionId: 'uuid-aaa',
  });
  // Expected exact sequence from legacy ClaudeSession.buildSpawnArgs with all-null options
  const expected = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions',
    '--mcp-config', MCP_CONFIG,
    '--tools', DEFAULT_TOOLS,
    '--settings', JSON.stringify({ hooks: buildHooksSettings(DEFAULT_TOOLS) }),
    '--session-id', 'uuid-aaa',
  ];
  assert.deepEqual(args, expected);
});

test('buildSpawnArgs with full options — system-prompt, append, model, agent, plugin-dir (×2), outputStyle, resume', () => {
  const args = buildSpawnArgs({
    tools: 'Bash,Read',
    systemPrompt: 'X',
    appendSystemPrompt: 'Y',
    model: 'claude-opus-4-6',
    claudeAgent: 'coder',
    pluginDirs: ['/a', '/b'],
    outputStyle: 'z',
    needsResume: true,
    sessionId: 'uuid-bbb',
  });
  const expected = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions',
    '--mcp-config', MCP_CONFIG,
    '--tools', 'Bash,Read',
    '--system-prompt', 'X',
    '--append-system-prompt', 'Y',
    '--model', 'claude-opus-4-6',
    '--agent', 'coder',
    '--plugin-dir', '/a',
    '--plugin-dir', '/b',
    '--settings', JSON.stringify({ hooks: buildHooksSettings('Bash,Read'), outputStyle: 'z' }),
    '--resume', 'uuid-bbb',
  ];
  assert.deepEqual(args, expected);
});

// --- buildSpawnArgs: Feishu MCP layering (Feishu-originated sessions) ---

test('buildSpawnArgs loadFeishuMcp — layers cortex-feishu config on top of the full MCP set', () => {
  const args = buildSpawnArgs({
    tools: null,
    systemPrompt: null,
    appendSystemPrompt: null,
    model: null,
    claudeAgent: null,
    pluginDirs: null,
    outputStyle: null,
    needsResume: false,
    sessionId: 'uuid-feishu',
    loadFeishuMcp: true,
  });
  // --mcp-config is variadic: both the base full config and the feishu config are passed.
  const i = args.indexOf('--mcp-config');
  assert.ok(i >= 0, '--mcp-config present');
  assert.equal(args[i + 1], MCP_CONFIG, 'base full config first');
  assert.equal(args[i + 2], FEISHU_MCP_CONFIG, 'feishu config layered second');
});

test('buildSpawnArgs without loadFeishuMcp — does NOT load the cortex-feishu config', () => {
  const args = buildSpawnArgs({
    tools: null,
    systemPrompt: null,
    appendSystemPrompt: null,
    model: null,
    claudeAgent: null,
    pluginDirs: null,
    outputStyle: null,
    needsResume: false,
    sessionId: 'uuid-noFeishu',
  });
  assert.ok(!args.includes(FEISHU_MCP_CONFIG), 'non-feishu session must NOT load the cortex-feishu server');
});

test('buildSpawnArgs loadWebMcp — layers cortex-web config on top of the full MCP set', () => {
  const args = buildSpawnArgs({
    tools: null,
    systemPrompt: null,
    appendSystemPrompt: null,
    model: null,
    claudeAgent: null,
    pluginDirs: null,
    outputStyle: null,
    needsResume: false,
    sessionId: 'uuid-web',
    loadWebMcp: true,
  });
  const i = args.indexOf('--mcp-config');
  assert.ok(i >= 0, '--mcp-config present');
  assert.equal(args[i + 1], MCP_CONFIG, 'base full config first');
  assert.equal(args[i + 2], WEB_MCP_CONFIG, 'web config layered second');
});

test('buildSpawnArgs without loadWebMcp — does NOT load the cortex-web config', () => {
  const args = buildSpawnArgs({
    tools: null,
    systemPrompt: null,
    appendSystemPrompt: null,
    model: null,
    claudeAgent: null,
    pluginDirs: null,
    outputStyle: null,
    needsResume: false,
    sessionId: 'uuid-noWeb',
  });
  assert.ok(!args.includes(WEB_MCP_CONFIG), 'non-web session must NOT load the cortex-web server');
});

test('buildSpawnArgs loadWebMcp — thread/core session (CORE_MCP_CONFIG) suppresses the web layer', () => {
  const args = buildSpawnArgs({
    tools: null,
    systemPrompt: null,
    appendSystemPrompt: null,
    model: null,
    claudeAgent: null,
    pluginDirs: null,
    outputStyle: null,
    needsResume: false,
    sessionId: 'uuid-web-thread',
    mcpConfigPath: CORE_MCP_CONFIG,
    loadWebMcp: true,
  });
  assert.ok(!args.includes(WEB_MCP_CONFIG), 'core/thread sessions must stay on the core server set only');
});

test('buildSpawnArgs loadFeishuMcp — thread/core session (CORE_MCP_CONFIG) suppresses the feishu layer', () => {
  const args = buildSpawnArgs({
    tools: null,
    systemPrompt: null,
    appendSystemPrompt: null,
    model: null,
    claudeAgent: null,
    pluginDirs: null,
    outputStyle: null,
    needsResume: false,
    sessionId: 'uuid-feishu-thread',
    mcpConfigPath: CORE_MCP_CONFIG,
    loadFeishuMcp: true,
  });
  assert.ok(!args.includes(FEISHU_MCP_CONFIG), 'core/thread sessions must stay on the core server set only');
});

// --- buildSpawnArgs: TUI mode (DR-0012) ---

test("buildSpawnArgs mode='tui' — omits -p / stream-json flags, layers TUI bridge on the full MCP set + TUI_TOOLS", () => {
  const args = buildSpawnArgs({
    tools: null,
    systemPrompt: null,
    appendSystemPrompt: null,
    model: null,
    claudeAgent: null,
    pluginDirs: null,
    outputStyle: null,
    needsResume: false,
    sessionId: 'uuid-tui-1',
    mode: 'tui',
  });
  // Must NOT contain -p / --input-format / --output-format / --verbose
  assert.ok(!args.includes('-p'), 'tui mode must not pass -p');
  assert.ok(!args.includes('--input-format'), 'tui mode must not pass --input-format');
  assert.ok(!args.includes('--output-format'), 'tui mode must not pass --output-format');
  assert.ok(!args.includes('--verbose'), 'tui mode must not pass --verbose');
  // Must contain permission bypass + TUI defaults + session id
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.ok(args.includes('--permission-mode'));
  assert.ok(args.includes('bypassPermissions'));
  // MCP loading mirrors print mode (full MCP_CONFIG) AND additionally layers the TUI bridge.
  assert.ok(args.includes(MCP_CONFIG), 'tui non-thread loads the same base MCP set as print mode');
  assert.ok(args.includes(TUI_MCP_CONFIG), 'tui non-thread also loads the cortex-tui-bridge server');
  assert.ok(args.includes(TUI_TOOLS));
  assert.ok(args.includes('--session-id'));
  assert.ok(args.includes('uuid-tui-1'));
});

test("buildSpawnArgs mode='tui' — thread/core session (mcpConfigPath=CORE_MCP_CONFIG) drops the TUI bridge", () => {
  const args = buildSpawnArgs({
    tools: null,
    systemPrompt: null,
    appendSystemPrompt: null,
    model: null,
    claudeAgent: null,
    pluginDirs: null,
    outputStyle: null,
    needsResume: false,
    sessionId: 'uuid-tui-thread',
    mode: 'tui',
    mcpConfigPath: CORE_MCP_CONFIG,
  });
  assert.ok(args.includes(CORE_MCP_CONFIG), 'thread tui loads only the core MCP server set');
  assert.ok(!args.includes(TUI_MCP_CONFIG), 'thread tui must NOT load the cortex-tui-bridge server');
  assert.ok(!args.includes(MCP_CONFIG), 'thread tui must not fall back to the full MCP set');
  // No bridge → fall back to the standard tool whitelist (not TUI_TOOLS, which references bridge tools).
  assert.ok(!args.includes(TUI_TOOLS), 'thread tui must not whitelist the bridge tools');
});

test("buildSpawnArgs mode='tui' — explicit tools have interaction tools stripped", () => {
  const args = buildSpawnArgs({
    tools: 'Bash,Read,AskUserQuestion,EnterPlanMode,ExitPlanMode,Write',
    systemPrompt: null,
    appendSystemPrompt: null,
    model: null,
    claudeAgent: null,
    pluginDirs: null,
    outputStyle: null,
    needsResume: false,
    sessionId: 'u',
    mode: 'tui',
  });
  const toolsArg = args[args.indexOf('--tools') + 1];
  const tools = toolsArg.split(',');
  assert.ok(!tools.includes('AskUserQuestion'), 'AskUserQuestion must be stripped in TUI mode');
  assert.ok(!tools.includes('EnterPlanMode'), 'EnterPlanMode must be stripped in TUI mode');
  assert.ok(!tools.includes('ExitPlanMode'), 'ExitPlanMode must be stripped in TUI mode');
  assert.ok(tools.includes('Bash'));
  assert.ok(tools.includes('Read'));
  assert.ok(tools.includes('Write'));
});

test("buildSpawnArgs mode='tui' — thread/core session also strips interaction tools from explicit list", () => {
  const args = buildSpawnArgs({
    tools: DEFAULT_TOOLS,
    systemPrompt: null,
    appendSystemPrompt: null,
    model: null,
    claudeAgent: null,
    pluginDirs: null,
    outputStyle: null,
    needsResume: false,
    sessionId: 'u',
    mode: 'tui',
    mcpConfigPath: CORE_MCP_CONFIG,
  });
  const toolsArg = args[args.indexOf('--tools') + 1];
  const tools = toolsArg.split(',');
  assert.ok(!tools.includes('AskUserQuestion'), 'thread tui must also strip AskUserQuestion');
  assert.ok(!tools.includes('EnterPlanMode'), 'thread tui must also strip EnterPlanMode');
  assert.ok(!tools.includes('ExitPlanMode'), 'thread tui must also strip ExitPlanMode');
  assert.ok(tools.includes('Bash'));
});

test("buildSpawnArgs mode='tui' — needsResume uses --resume instead of --session-id", () => {
  const args = buildSpawnArgs({
    tools: null,
    systemPrompt: null,
    appendSystemPrompt: null,
    model: null,
    claudeAgent: null,
    pluginDirs: null,
    outputStyle: null,
    needsResume: true,
    sessionId: 'uuid-resume',
    mode: 'tui',
  });
  assert.ok(args.includes('--resume'));
  assert.ok(!args.includes('--session-id'));
  // sessionId still appears as the --resume argument value
  assert.equal(args[args.indexOf('--resume') + 1], 'uuid-resume');
});

test("buildSpawnArgs mode='tui' — system-prompt / model / agent / plugin-dir pass through identically", () => {
  const args = buildSpawnArgs({
    tools: null,
    systemPrompt: 'SYS',
    appendSystemPrompt: 'APPEND',
    model: 'claude-sonnet-4-6',
    claudeAgent: 'coder',
    pluginDirs: ['/p1', '/p2'],
    outputStyle: 'style-a',
    needsResume: false,
    sessionId: 'u',
    mode: 'tui',
  });
  assert.ok(args.includes('--system-prompt'));
  assert.equal(args[args.indexOf('--system-prompt') + 1], 'SYS');
  assert.ok(args.includes('--append-system-prompt'));
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], 'APPEND');
  assert.ok(args.includes('--model'));
  assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-4-6');
  assert.ok(args.includes('--agent'));
  assert.equal(args[args.indexOf('--agent') + 1], 'coder');
  // Both plugin-dirs appear
  const pluginDirArgs: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--plugin-dir') pluginDirArgs.push(args[i + 1]);
  }
  assert.deepEqual(pluginDirArgs, ['/p1', '/p2']);
});

test("buildSpawnArgs mode='print' (default) — behavior unchanged from existing baseline", () => {
  // When mode is omitted entirely, must produce the exact same argv as the legacy lock-down test.
  // This guards regression for all -p mode callers that don't set mode.
  const explicitPrint = buildSpawnArgs({
    tools: null,
    systemPrompt: null,
    appendSystemPrompt: null,
    model: null,
    claudeAgent: null,
    pluginDirs: null,
    outputStyle: null,
    needsResume: false,
    sessionId: 'uuid-baseline',
    mode: 'print',
  });
  const implicitDefault = buildSpawnArgs({
    tools: null,
    systemPrompt: null,
    appendSystemPrompt: null,
    model: null,
    claudeAgent: null,
    pluginDirs: null,
    outputStyle: null,
    needsResume: false,
    sessionId: 'uuid-baseline',
  });
  assert.deepEqual(implicitDefault, explicitPrint);
  // And the legacy expected sequence is preserved
  assert.ok(explicitPrint[0] === '-p');
  assert.ok(explicitPrint.includes('--input-format'));
});

// --- buildSpawnArgs: print-mode interaction-bridge tools (user-initiated sessions) ---
// The native EnterPlanMode/ExitPlanMode/AskUserQuestion tools are filtered out by headless -p
// mode. For user-message-initiated (non-thread) sessions we layer the cortex-tui-bridge MCP
// server + its 3 tools so plan/ask still works over the channel. Thread/core sessions never get it.

test('buildSpawnArgs print + isUserInitiated — layers TUI bridge MCP config and appends the 3 bridge tools', () => {
  const args = buildSpawnArgs({
    tools: null,
    systemPrompt: null,
    appendSystemPrompt: null,
    model: null,
    claudeAgent: null,
    pluginDirs: null,
    outputStyle: null,
    needsResume: false,
    sessionId: 'uuid-print-user',
    isUserInitiated: true,
  });
  // Still print mode (-p) and still loads the full base MCP set
  assert.ok(args.includes('-p'), 'print mode preserved');
  const i = args.indexOf('--mcp-config');
  assert.equal(args[i + 1], MCP_CONFIG, 'base full config first');
  assert.ok(args.includes(TUI_MCP_CONFIG), 'user-initiated print session also loads the cortex-tui-bridge server');
  // Tools: base DEFAULT_TOOLS retained + the 3 bridge tools appended
  const tools = args[args.indexOf('--tools') + 1].split(',');
  assert.ok(tools.includes('Bash'), 'base tools retained');
  for (const t of TUI_BRIDGE_TOOLS) {
    assert.ok(tools.includes(t), `bridge tool ${t} appended`);
  }
});

test('buildSpawnArgs print + isUserInitiated + core (CORE_MCP_CONFIG) — thread session gets NO bridge', () => {
  const args = buildSpawnArgs({
    tools: null,
    systemPrompt: null,
    appendSystemPrompt: null,
    model: null,
    claudeAgent: null,
    pluginDirs: null,
    outputStyle: null,
    needsResume: false,
    sessionId: 'uuid-print-thread',
    mcpConfigPath: CORE_MCP_CONFIG,
    isUserInitiated: true,
  });
  assert.ok(!args.includes(TUI_MCP_CONFIG), 'thread/core sessions must NOT load the tui bridge');
  const tools = args[args.indexOf('--tools') + 1].split(',');
  for (const t of TUI_BRIDGE_TOOLS) {
    assert.ok(!tools.includes(t), `thread session must NOT get bridge tool ${t}`);
  }
});

test('buildSpawnArgs print WITHOUT isUserInitiated — no bridge (baseline unchanged)', () => {
  const args = buildSpawnArgs({
    tools: null,
    systemPrompt: null,
    appendSystemPrompt: null,
    model: null,
    claudeAgent: null,
    pluginDirs: null,
    outputStyle: null,
    needsResume: false,
    sessionId: 'uuid-print-nonuser',
  });
  assert.ok(!args.includes(TUI_MCP_CONFIG), 'non-user-initiated print session must NOT load the tui bridge');
  const tools = args[args.indexOf('--tools') + 1].split(',');
  for (const t of TUI_BRIDGE_TOOLS) {
    assert.ok(!tools.includes(t), `non-user-initiated session must NOT get bridge tool ${t}`);
  }
});

test('buildSpawnArgs print + isUserInitiated with explicit tools — bridge tools appended to the explicit list', () => {
  const args = buildSpawnArgs({
    tools: 'Bash,Read,Write',
    systemPrompt: null,
    appendSystemPrompt: null,
    model: null,
    claudeAgent: null,
    pluginDirs: null,
    outputStyle: null,
    needsResume: false,
    sessionId: 'uuid-print-user-explicit',
    isUserInitiated: true,
  });
  const tools = args[args.indexOf('--tools') + 1].split(',');
  assert.ok(tools.includes('Bash') && tools.includes('Read') && tools.includes('Write'), 'explicit tools retained');
  for (const t of TUI_BRIDGE_TOOLS) {
    assert.ok(tools.includes(t), `bridge tool ${t} appended to explicit list`);
  }
});

test('TUI_BRIDGE_TOOLS — the 3 mcp bridge tool names, also contained in TUI_TOOLS', () => {
  assert.deepEqual([...TUI_BRIDGE_TOOLS].sort(), [
    'mcp__cortex-tui-bridge__cortex_ask_user',
    'mcp__cortex-tui-bridge__cortex_plan_enter',
    'mcp__cortex-tui-bridge__cortex_plan_exit',
  ]);
  const tuiTools = TUI_TOOLS.split(',');
  for (const t of TUI_BRIDGE_TOOLS) {
    assert.ok(tuiTools.includes(t), `TUI_TOOLS must still contain ${t}`);
  }
});

// --- selectClaudeMode (DR-0012 routing) ---

test("selectClaudeMode returns 'print' for AgentSpawnConfig without claudeBackend", () => {
  assert.equal(selectClaudeMode({ sessionId: null, sessionKey: 'k', resume: false } as any), 'print');
});

test("selectClaudeMode returns 'tui' when claudeBackend='tui'", () => {
  assert.equal(selectClaudeMode({ sessionId: null, sessionKey: 'k', resume: false, claudeBackend: 'tui' } as any), 'tui');
});

test("selectClaudeMode returns 'print' for unknown claudeBackend value (conservative)", () => {
  assert.equal(selectClaudeMode({ sessionId: null, sessionKey: 'k', resume: false, claudeBackend: 'bogus' } as any), 'print');
});

// --- recoverTuiOrphans (DR-0012 §3.6 startup sweep) ---

function makeRecordingExec(scenario: {
  listOutput: string;
  listStatus?: number;
  killStatus?: number;
}): { exec: (a: string[]) => TmuxExecResult; calls: string[][] } {
  const calls: string[][] = [];
  const exec = (args: string[]): TmuxExecResult => {
    calls.push([...args]);
    if (args[0] === 'list-sessions') {
      return { stdout: scenario.listOutput, stderr: '', status: scenario.listStatus ?? 0 };
    }
    if (args[0] === 'kill-session') {
      return { stdout: '', stderr: '', status: scenario.killStatus ?? 0 };
    }
    return { stdout: '', stderr: '', status: 0 };
  };
  return { exec, calls };
}

test('recoverTuiOrphans returns empty when no tmux sessions exist', () => {
  const { exec, calls } = makeRecordingExec({ listOutput: '', listStatus: 1 });
  const r = recoverTuiOrphans(exec);
  assert.deepEqual(r.found, []);
  assert.deepEqual(r.killed, []);
  // Only the list call happened — no kill attempts
  assert.equal(calls.filter(c => c[0] === 'kill-session').length, 0);
});

test('recoverTuiOrphans only sweeps sessions matching cortex-claude- prefix', () => {
  const { exec, calls } = makeRecordingExec({
    listOutput: 'cortex-claude-abc\nuser-shell\ncortex-claude-def\nother\n',
  });
  const r = recoverTuiOrphans(exec);
  assert.deepEqual(r.found.sort(), ['cortex-claude-abc', 'cortex-claude-def']);
  assert.deepEqual(r.killed.sort(), ['cortex-claude-abc', 'cortex-claude-def']);
  const killTargets = calls.filter(c => c[0] === 'kill-session').map(c => c[c.indexOf('-t') + 1]);
  assert.deepEqual(killTargets.sort(), ['cortex-claude-abc', 'cortex-claude-def']);
  // Did NOT try to kill the unrelated tmux sessions
  assert.ok(!killTargets.includes('user-shell'));
  assert.ok(!killTargets.includes('other'));
});

// --- TUI_TOOLS constant shape ---

test('TUI_TOOLS excludes AskUserQuestion / EnterPlanMode / ExitPlanMode and includes 3 MCP replacements', () => {
  const tools = TUI_TOOLS.split(',');
  assert.ok(!tools.includes('AskUserQuestion'), 'TUI_TOOLS must exclude AskUserQuestion');
  assert.ok(!tools.includes('EnterPlanMode'), 'TUI_TOOLS must exclude EnterPlanMode');
  assert.ok(!tools.includes('ExitPlanMode'), 'TUI_TOOLS must exclude ExitPlanMode');
  assert.ok(tools.includes('mcp__cortex-tui-bridge__cortex_plan_enter'));
  assert.ok(tools.includes('mcp__cortex-tui-bridge__cortex_plan_exit'));
  assert.ok(tools.includes('mcp__cortex-tui-bridge__cortex_ask_user'));
  // Non-replaced tools still present
  assert.ok(tools.includes('Bash'));
  assert.ok(tools.includes('Read'));
  assert.ok(tools.includes('Write'));
});

// --- buildHooksSettings ---

test('buildHooksSettings default — PreToolUse has only Edit|Write matcher', () => {
  const settings = buildHooksSettings('Bash,Read,Edit,Write');
  const matchers = settings.PreToolUse.map((h: any) => h.matcher);
  assert.deepEqual(matchers, ['Edit|Write']);
  // PostToolUse + PermissionRequest remain fixed
  assert.ok(Array.isArray(settings.PostToolUse));
  assert.ok(Array.isArray(settings.PermissionRequest));
});

test('buildHooksSettings with AskUserQuestion + ExitPlanMode — all three PreToolUse matchers appear', () => {
  const settings = buildHooksSettings('Edit,Write,AskUserQuestion,ExitPlanMode');
  const matchers = settings.PreToolUse.map((h: any) => h.matcher);
  assert.deepEqual(matchers, ['Edit|Write', 'AskUserQuestion', 'ExitPlanMode']);
});

test('buildHooksSettings null (tools unset) — uses DEFAULT_TOOLS which includes AskUserQuestion + ExitPlanMode', () => {
  const settings = buildHooksSettings(null);
  const matchers = settings.PreToolUse.map((h: any) => h.matcher);
  assert.deepEqual(matchers, ['Edit|Write', 'AskUserQuestion', 'ExitPlanMode']);
});

// --- SESSION_START_HOOKS ---

test('SESSION_START_HOOKS — includes cortex-md-injector with expected matchers', () => {
  assert.equal(SESSION_START_HOOKS.length, 1);
  assert.equal(SESSION_START_HOOKS[0].matcher, 'startup|resume|clear|compact');
  assert.equal(SESSION_START_HOOKS[0].hooks.length, 1);
  assert.ok((SESSION_START_HOOKS[0].hooks[0] as any).command.includes('cortex-md-injector.mjs'));
});

// --- POST_TOOL_USE_HOOKS cortex-md-injector entry ---

test('POST_TOOL_USE_HOOKS — includes cortex-md-injector entry for Read', () => {
  const entry = POST_TOOL_USE_HOOKS.find((h: any) => h.matcher === 'Read');
  assert.ok(entry, 'expected cortex-md-injector entry in POST_TOOL_USE_HOOKS');
  assert.equal(entry.hooks.length, 1);
  assert.ok((entry.hooks[0] as any).command.includes('cortex-md-injector.mjs'));
});

// --- buildHooksSettings includes session keys ---

test('buildHooksSettings — return value includes SessionStart key', () => {
  const settings = buildHooksSettings(null);
  assert.ok(Array.isArray(settings.SessionStart));
  assert.equal(settings.SessionStart.length, 1);
  assert.equal((settings as any).UserPromptSubmit, undefined);
});

// --- buildClaudeEnv extraEnv merge ---

test('buildClaudeEnv — baseline strips CLAUDE_CODE_* from parent and sets DISABLE_AUTO_MEMORY', () => {
  const prev = process.env.CLAUDE_CODE_ATTRIBUTION_HEADER;
  process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '1';
  try {
    const env = buildClaudeEnv('C1', 'sid-1');
    assert.equal(env.CLAUDE_CODE_ATTRIBUTION_HEADER, undefined);
    assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
    assert.equal(env.CORTEX_SESSION_ID, 'sid-1');
    assert.equal(env.SLACK_CHANNEL, 'C1');
    // Startup-latency trims (set after the CLAUDE_CODE_* strip loop, so they survive it).
    assert.equal(env.DISABLE_AUTOUPDATER, '1');
    assert.equal(env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL, '1');
    assert.equal(env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL, '1');
    assert.equal(env.CLAUDE_CODE_AUTO_CONNECT_IDE, 'false');
    assert.equal(env.CLAUDE_CODE_DISABLE_POLICY_SKILLS, '1');
    assert.equal(env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE, '1');
    // We deliberately do NOT disable telemetry/experiment-gates by default.
    assert.equal(env.DISABLE_TELEMETRY, undefined);
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER;
    else process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = prev;
  }
});

test('buildClaudeEnv — extraEnv survives CLAUDE_CODE_* strip and can override DISABLE_AUTO_MEMORY', () => {
  const env = buildClaudeEnv('C1', 'sid-1', null, null, 'http://127.0.0.1:9880/m/qwen-ksu/anthropic', {
    CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });
  assert.equal(env.CLAUDE_CODE_ATTRIBUTION_HEADER, '0');
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  // Other Cortex defaults remain intact
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9880/m/qwen-ksu/anthropic');
});

// --- buildClaudeEnv: cortex context env vars (CORTEX_THREAD_ID/PROFILE/PROJECT/SESSION_NAME) ---

test('buildClaudeEnv — context.threadId/profile/project/sessionName surface as CORTEX_* env vars', () => {
  const env = buildClaudeEnv('C1', 'sid-1', null, null, undefined, undefined, {
    threadId: 'thr_abc123',
    profile: 'fast-worker',
    project: 'cortex-self',
    sessionName: 'cortex-aaa111',
  });
  assert.equal(env.CORTEX_THREAD_ID, 'thr_abc123');
  assert.equal(env.CORTEX_PROFILE, 'fast-worker');
  assert.equal(env.CORTEX_PROJECT, 'cortex-self');
  assert.equal(env.CORTEX_SESSION_NAME, 'cortex-aaa111');
  // Existing fields still intact
  assert.equal(env.SLACK_CHANNEL, 'C1');
  assert.equal(env.CORTEX_SESSION_ID, 'sid-1');
});

test('buildClaudeEnv — omitted context fields do not pollute env with empty strings', () => {
  const env = buildClaudeEnv('C1', 'sid-1');
  assert.equal(env.CORTEX_THREAD_ID, undefined);
  assert.equal(env.CORTEX_PROFILE, undefined);
  assert.equal(env.CORTEX_PROJECT, undefined);
  assert.equal(env.CORTEX_SESSION_NAME, undefined);
});

test('buildClaudeEnv — context.taskId/taskProject surface as CORTEX_TASK_ID/PROJECT', () => {
  const env = buildClaudeEnv('C1', 'sid-1', null, null, undefined, undefined, {
    threadId: 'thr_abc',
    taskId: 'a1b2',
    taskProject: 'cortex-self',
  });
  assert.equal(env.CORTEX_TASK_ID, 'a1b2');
  assert.equal(env.CORTEX_TASK_PROJECT, 'cortex-self');
});

test('buildClaudeEnv — omitted task context does not set CORTEX_TASK_* vars', () => {
  const env = buildClaudeEnv('C1', 'sid-1');
  assert.equal(env.CORTEX_TASK_ID, undefined);
  assert.equal(env.CORTEX_TASK_PROJECT, undefined);
});

test('buildClaudeEnv — partial context (only threadId) sets only that var', () => {
  const env = buildClaudeEnv('C1', 'sid-1', null, null, undefined, undefined, { threadId: 'thr_xyz' });
  assert.equal(env.CORTEX_THREAD_ID, 'thr_xyz');
  assert.equal(env.CORTEX_PROFILE, undefined);
  assert.equal(env.CORTEX_PROJECT, undefined);
  assert.equal(env.CORTEX_SESSION_NAME, undefined);
});

// --- summarizeToolInput ---

test('summarizeToolInput covers Bash/Read/Write/Edit/Grep/Glob/Task/mcp__cortex__slack_send_file/unknown', () => {
  assert.equal(summarizeToolInput('Bash', { command: 'ls' }), 'ls');
  assert.equal(summarizeToolInput('Read', { file_path: '/a/b' }), '/a/b');
  assert.equal(summarizeToolInput('Write', { file_path: '/c/d' }), '/c/d');
  assert.equal(summarizeToolInput('Edit', { file_path: '/e/f' }), '/e/f');
  assert.equal(summarizeToolInput('Grep', { pattern: 'foo' }), 'foo');
  assert.equal(summarizeToolInput('Glob', { pattern: '*.ts' }), '*.ts');
  assert.equal(summarizeToolInput('Task', { description: 'do it' }), 'do it');
  assert.equal(
    summarizeToolInput('mcp__cortex__slack_send_file', { file_path: '/x', comment: 'hi' }),
    'hi [file: /x]',
  );
  assert.equal(
    summarizeToolInput('mcp__cortex__slack_send_file', { file_path: '/x' }),
    '[file: /x]',
  );
  assert.equal(summarizeToolInput('UnknownTool', { foo: 1 }), JSON.stringify({ foo: 1 }));
});

// --- extractAskUserQuestions ---

test('extractAskUserQuestions filters tool_use blocks by name AskUserQuestion and preserves toolUseId/questions', () => {
  const data = {
    message: {
      content: [
        { type: 'text', text: 'hello' },
        {
          type: 'tool_use',
          name: 'AskUserQuestion',
          id: 'tu-1',
          input: { questions: [{ question: 'Q1' }] },
        },
        { type: 'tool_use', name: 'Bash', id: 'tu-2', input: { command: 'ls' } },
        {
          type: 'tool_use',
          name: 'AskUserQuestion',
          id: 'tu-3',
          input: { questions: [{ question: 'Q2' }, { question: 'Q3' }] },
        },
      ],
    },
  };
  const questions = extractAskUserQuestions(data, 'session-xyz');
  assert.equal(questions.length, 2);
  assert.equal(questions[0].toolUseId, 'tu-1');
  assert.equal(questions[0].sessionId, 'session-xyz');
  assert.deepEqual(questions[0].questions, [{ question: 'Q1' }]);
  assert.equal(questions[1].toolUseId, 'tu-3');
  assert.equal(questions[1].questions.length, 2);
});

// --- activePlanFiles helpers (encapsulation per Design Decision 3) ---

test('setActivePlanFile / getCurrentPlanFilePath / clearActivePlanFile round-trip', () => {
  assert.equal(getCurrentPlanFilePath('sess-1'), null);
  setActivePlanFile('sess-1', '/plan/a.md');
  assert.equal(getCurrentPlanFilePath('sess-1'), '/plan/a.md');
  clearActivePlanFile('sess-1');
  assert.equal(getCurrentPlanFilePath('sess-1'), null);
  // null / empty sessionId short-circuits
  assert.equal(getCurrentPlanFilePath(''), null);
});

// --- ClaudeAdapter.spawn — AgentSpawnConfig → CLI args parity (Blocker fix from Plan Review iter 1) ---

test('ClaudeAdapter.spawn: full AgentSpawnConfig produces expected CLI args (canonical → native tool names)', () => {
  const args = adapterTest.computeSpawnArgs({
    sessionId: 'uuid-xxx',
    sessionKey: 'thr:e0b6:1',
    resume: false,
    systemPrompt: 'X',
    appendSystemPrompt: 'Y',
    tools: ['bash', 'read', 'ask_user_question'],
    pluginDirs: ['/a', '/b'],
    model: 'claude-opus-4-6',
    outputStyle: 'z',
  });
  // Canonical tools → native names: bash→Bash, read→Read, ask_user_question→AskUserQuestion
  const nativeTools = 'Bash,Read,AskUserQuestion';
  const expected = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions',
    '--mcp-config', MCP_CONFIG,
    '--tools', nativeTools,
    '--system-prompt', 'X',
    '--append-system-prompt', 'Y',
    '--model', 'claude-opus-4-6',
    '--plugin-dir', '/a',
    '--plugin-dir', '/b',
    '--settings', JSON.stringify({ hooks: buildHooksSettings(nativeTools), outputStyle: 'z' }),
    '--session-id', 'uuid-xxx',
  ];
  assert.deepEqual(args, expected);
});

test('ClaudeAdapter.spawn: resume:true swaps --session-id for --resume', () => {
  const args = adapterTest.computeSpawnArgs({
    sessionId: 'uuid-yyy',
    sessionKey: 'k',
    resume: true,
  });
  const last2 = args.slice(-2);
  assert.deepEqual(last2, ['--resume', 'uuid-yyy']);
});

test('ClaudeAdapter.spawn: no tools provided → --tools uses DEFAULT_TOOLS', () => {
  const args = adapterTest.computeSpawnArgs({
    sessionId: 'uuid-zzz',
    sessionKey: 'k',
    resume: false,
  });
  const toolsIdx = args.indexOf('--tools');
  assert.ok(toolsIdx >= 0, '--tools flag must appear');
  assert.equal(args[toolsIdx + 1], DEFAULT_TOOLS);
});

// Regression: appendSystemPrompt must be propagated through deriveClaudeSpawnOptions()
// to the --append-system-prompt CLI flag.
test('ClaudeAdapter.spawn: appendSystemPrompt is propagated to --append-system-prompt (regression)', () => {
  const args = adapterTest.computeSpawnArgs({
    sessionId: 'uuid-append',
    sessionKey: 'k',
    resume: false,
    appendSystemPrompt: 'custom-append-text',
  });
  const flagIdx = args.indexOf('--append-system-prompt');
  assert.ok(flagIdx >= 0, '--append-system-prompt flag must appear when config.appendSystemPrompt is set');
  assert.equal(args[flagIdx + 1], 'custom-append-text');
});

// task f7cf satisfied the previous "iterating rejects with task f7cf" test: ClaudeAdapter.spawn()
// now returns a real event stream driven by the pooled ClaudeSession. End-to-end coverage
// lives in tests/run-with-adapter.test.ts (fake-adapter regression: callback ordering,
// rate-limit surfacing via AgentResult, error, kill). Here we keep pure-function parity
// tests for _test.computeSpawnArgs / buildSpawnArgs / buildHooksSettings.
