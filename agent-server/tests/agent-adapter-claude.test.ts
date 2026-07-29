// input:  Claude adapter modules, registry fixtures, assertions
// output: CLI args, env, safe hooks, parsing, compact verification
// pos:    Claude adapter behavior tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildSpawnArgs, buildClaudeEnv } from '../src/agent-adapter/claude/spawn-args.js';
import {
  buildHooksSettings,
  POST_TOOL_USE_HOOKS,
  SESSION_START_HOOKS,
} from '../src/agent-adapter/claude/hooks-builder.js';
import { summarizeToolInput } from '../src/agent-adapter/claude/tool-summarizers.js';
import {
  CORE_MCP_CONFIG,
  DEFAULT_TOOLS,
  FEISHU_MCP_CONFIG,
  MANAGER_QA_MCP_CONFIG,
  MCP_CONFIG,
  TASKS_MCP_CONFIG,
  THREAD_MCP_CONFIG,
  TUI_BRIDGE_TOOLS,
  TUI_MCP_CONFIG,
  TUI_TOOLS,
  WEB_MCP_CONFIG,
} from '../src/agent-adapter/claude/defaults.js';
import {
  extractAskUserQuestions,
  setActivePlanFile,
  clearActivePlanFile,
  getCurrentPlanFilePath,
} from '../src/agent-adapter/claude/event-parser.js';
import { _test as adapterTest, selectClaudeMode, recoverTuiOrphans } from '../src/agent-adapter/claude/adapter.js';
import type { TmuxExecResult } from '../src/agent-adapter/claude/tmux-control.js';
import { CONFIG_DIR, DEFAULTS_DIR, HOOKS_DIR } from '../src/core/paths.js';
import type { HookEntry } from '../src/store/hook-registry.js';

const HOOK_REGISTRY_DIR = path.join(CONFIG_DIR, 'hooks');
const SHIPPED_HOOK_REGISTRY_DIR = path.join(DEFAULTS_DIR, 'config', 'hooks');
const inheritedLegacyHooks = process.env.CORTEX_HOOKS_LEGACY;

function resetHookRegistry(): void {
  fs.rmSync(HOOK_REGISTRY_DIR, { recursive: true, force: true });
  fs.cpSync(SHIPPED_HOOK_REGISTRY_DIR, HOOK_REGISTRY_DIR, { recursive: true });
}

function writeHookRegistry(entries: readonly HookEntry[]): void {
  fs.rmSync(HOOK_REGISTRY_DIR, { recursive: true, force: true });
  fs.mkdirSync(HOOK_REGISTRY_DIR, { recursive: true });
  entries.forEach((entry, index) => {
    const filename = `${String(index + 1).padStart(2, '0')}-${entry.id}.json`;
    fs.writeFileSync(path.join(HOOK_REGISTRY_DIR, filename), `${JSON.stringify(entry, null, 2)}\n`);
  });
}

function withHookRegistry<T>(entries: readonly HookEntry[], run: () => T): T {
  const legacy = process.env.CORTEX_HOOKS_LEGACY;
  delete process.env.CORTEX_HOOKS_LEGACY;
  writeHookRegistry(entries);
  try {
    return run();
  } finally {
    resetHookRegistry();
    if (legacy === undefined) delete process.env.CORTEX_HOOKS_LEGACY;
    else process.env.CORTEX_HOOKS_LEGACY = legacy;
  }
}

beforeAll(() => {
  delete process.env.CORTEX_HOOKS_LEGACY;
  resetHookRegistry();
});

afterAll(() => {
  if (inheritedLegacyHooks === undefined) delete process.env.CORTEX_HOOKS_LEGACY;
  else process.env.CORTEX_HOOKS_LEGACY = inheritedLegacyHooks;
});

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
    '--replay-user-messages',
    '--include-partial-messages',
    '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions',
    '--mcp-config', MCP_CONFIG,
    '--tools', DEFAULT_TOOLS,
    '--settings', JSON.stringify({ hooks: buildHooksSettings(DEFAULT_TOOLS) }),
    '--session-id', 'uuid-aaa',
  ];
  assert.deepEqual(args, expected);
});

test('buildSpawnArgs direct session never loads the thread-control layer', () => {
  const args = buildSpawnArgs({
    tools: null,
    needsResume: false,
    sessionId: 'uuid-direct',
  });
  assert.ok(args.includes(MCP_CONFIG));
  assert.ok(!args.includes(CORE_MCP_CONFIG));
  assert.ok(!args.includes(TASKS_MCP_CONFIG));
  assert.ok(!args.includes(MANAGER_QA_MCP_CONFIG));
  assert.ok(!args.includes(THREAD_MCP_CONFIG));
});

test('buildSpawnArgs thread session layers core, tasks, manager Q&A, and thread configs', () => {
  const args = buildSpawnArgs({
    tools: null,
    needsResume: false,
    sessionId: 'uuid-thread',
    mcpConfigPath: CORE_MCP_CONFIG,
  });
  const start = args.indexOf('--mcp-config');
  assert.deepEqual(
    args.slice(start + 1, start + 5),
    [CORE_MCP_CONFIG, TASKS_MCP_CONFIG, MANAGER_QA_MCP_CONFIG, THREAD_MCP_CONFIG],
  );
  assert.ok(!args.includes(MCP_CONFIG));
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
    '--replay-user-messages',
    '--include-partial-messages',
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

test('buildSpawnArgs: thinking level is passed as --effort', () => {
  const args = buildSpawnArgs({
    tools: null,
    systemPrompt: null,
    appendSystemPrompt: null,
    model: null,
    claudeAgent: null,
    pluginDirs: null,
    outputStyle: null,
    thinking: 'xhigh',
    needsResume: false,
    sessionId: 'uuid-ccc',
  });
  const idx = args.indexOf('--effort');
  assert.ok(idx >= 0, '--effort must be present');
  assert.equal(args[idx + 1], 'xhigh');
});

test('buildSpawnArgs: no --effort when thinking is absent (backward compat)', () => {
  const base = {
    tools: null,
    systemPrompt: null,
    appendSystemPrompt: null,
    model: null,
    claudeAgent: null,
    pluginDirs: null,
    outputStyle: null,
    needsResume: false,
    sessionId: 'uuid-ddd',
  };
  assert.ok(!buildSpawnArgs(base).includes('--effort'));
  assert.ok(!buildSpawnArgs({ ...base, thinking: null }).includes('--effort'));
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

// --- buildSpawnArgs: token-level streaming (--include-partial-messages) ---
// The flag makes the CLI emit `stream_event` lines (message_start / content_block_start /
// content_block_delta / …) alongside the existing complete events. It is print-mode only and
// killable with CORTEX_STREAM_DELTAS=0.

const streamingBase = {
  tools: null,
  systemPrompt: null,
  appendSystemPrompt: null,
  model: null,
  claudeAgent: null,
  pluginDirs: null,
  outputStyle: null,
  needsResume: false,
};

test('buildSpawnArgs print: --include-partial-messages sits in the print block (token streaming on by default)', () => {
  const args = buildSpawnArgs({ ...streamingBase, sessionId: 'uuid-stream-1' });
  const idx = args.indexOf('--include-partial-messages');
  assert.ok(idx >= 0, '--include-partial-messages must be present by default');
  // The print block is everything between -p and the permission flags that follow it; the flag's
  // exact neighbour is not fixed (--replay-user-messages also lives there, for the injection ack).
  assert.ok(idx > args.indexOf('--verbose'), 'must sit inside the print block, after --verbose');
  assert.ok(idx < args.indexOf('--dangerously-skip-permissions'), 'must precede the shared flags');
});

test('buildSpawnArgs print: CORTEX_STREAM_DELTAS=0 kills --include-partial-messages', () => {
  const prev = process.env.CORTEX_STREAM_DELTAS;
  process.env.CORTEX_STREAM_DELTAS = '0';
  try {
    const args = buildSpawnArgs({ ...streamingBase, sessionId: 'uuid-stream-2' });
    assert.ok(!args.includes('--include-partial-messages'), 'kill switch must drop the flag');
    // Everything else is untouched — the rest of the print argv is the legacy sequence.
    assert.equal(args[0], '-p');
    assert.ok(args.includes('--verbose'));
  } finally {
    if (prev === undefined) delete process.env.CORTEX_STREAM_DELTAS;
    else process.env.CORTEX_STREAM_DELTAS = prev;
  }
});

test('buildSpawnArgs: any other CORTEX_STREAM_DELTAS value keeps streaming on', () => {
  const prev = process.env.CORTEX_STREAM_DELTAS;
  process.env.CORTEX_STREAM_DELTAS = '1';
  try {
    const args = buildSpawnArgs({ ...streamingBase, sessionId: 'uuid-stream-3' });
    assert.ok(args.includes('--include-partial-messages'));
  } finally {
    if (prev === undefined) delete process.env.CORTEX_STREAM_DELTAS;
    else process.env.CORTEX_STREAM_DELTAS = prev;
  }
});

test("buildSpawnArgs mode='tui': never passes --include-partial-messages (jsonl tail, not stdout)", () => {
  const args = buildSpawnArgs({ ...streamingBase, sessionId: 'uuid-stream-4', mode: 'tui' });
  assert.ok(!args.includes('--include-partial-messages'));
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
  // Mid-turn injection is a print-mode stdin capability; TUI drives the CLI through tmux keystrokes
  // and has no stream-json stdin to replay, so the ack flag must not leak into its argv.
  assert.ok(!args.includes('--replay-user-messages'), 'tui mode must not pass --replay-user-messages');
  // Must contain permission bypass + TUI defaults + session id
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.ok(args.includes('--permission-mode'));
  assert.ok(args.includes('bypassPermissions'));
  // MCP loading mirrors print mode (full MCP_CONFIG) AND additionally layers the TUI bridge.
  assert.ok(args.includes(MCP_CONFIG), 'tui non-thread loads the same base MCP set as print mode');
  assert.ok(!args.includes(THREAD_MCP_CONFIG), 'direct tui must not load thread control');
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
  assert.ok(args.includes(CORE_MCP_CONFIG), 'thread tui loads the remote execution server');
  assert.ok(args.includes(TASKS_MCP_CONFIG), 'thread tui loads read-only task monitoring');
  assert.ok(args.includes(MANAGER_QA_MCP_CONFIG), 'thread tui loads manager answer support');
  assert.ok(args.includes(THREAD_MCP_CONFIG), 'thread tui loads its control plane');
  assert.ok(!args.includes(TUI_MCP_CONFIG), 'thread tui must NOT load the cortex-tui-bridge server');
  assert.ok(!args.includes(MCP_CONFIG), 'thread tui must not fall back to the direct MCP set');
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
  assert.ok(!args.includes(THREAD_MCP_CONFIG), 'direct print must not load thread control');
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
  assert.ok(args.includes(TASKS_MCP_CONFIG), 'thread session gets task monitoring');
  assert.ok(args.includes(MANAGER_QA_MCP_CONFIG), 'thread session gets manager answer support');
  assert.ok(args.includes(THREAD_MCP_CONFIG), 'thread session gets thread control');
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

const GOLDEN_HOOKS_WITH_INTERACTION = `{"PreToolUse":[{"matcher":"Edit|Write","hooks":[{"type":"command","command":"node ${HOOKS_DIR}/sensitive-file-edit.mjs","timeout":10},{"type":"command","command":"node ${HOOKS_DIR}/tasks-yaml-guard.mjs","timeout":10}]},{"matcher":"AskUserQuestion","hooks":[{"type":"command","command":"node ${HOOKS_DIR}/ask-user-question-hook.mjs","timeout":3600}]},{"matcher":"ExitPlanMode","hooks":[{"type":"command","command":"node ${HOOKS_DIR}/exit-plan-mode-hook.mjs","timeout":3600}]}],"PostToolUse":[{"matcher":"Read|Grep","hooks":[{"type":"command","command":"node ${HOOKS_DIR}/memory-ref-tracker.mjs"},{"type":"command","command":"node ${HOOKS_DIR}/rules-loader.mjs"}]},{"matcher":"Read|Edit|Write|Skill","hooks":[{"type":"command","command":"node ${HOOKS_DIR}/session-activity-tracker.mjs"}]},{"matcher":"Read|Edit","hooks":[{"type":"command","command":"node ${HOOKS_DIR}/cortex-md-injector.mjs"}]}],"PermissionRequest":[{"matcher":"Edit|Write","hooks":[{"type":"command","command":"printf '{\\"hookSpecificOutput\\":{\\"hookEventName\\":\\"PermissionRequest\\",\\"decision\\":{\\"behavior\\":\\"allow\\"}}}'","timeout":5}]}],"SessionStart":[{"matcher":"startup|resume|clear|compact","hooks":[{"type":"command","command":"node ${HOOKS_DIR}/cortex-md-injector.mjs"}]}]}`;
const GOLDEN_HOOKS_WITHOUT_INTERACTION = `{"PreToolUse":[{"matcher":"Edit|Write","hooks":[{"type":"command","command":"node ${HOOKS_DIR}/sensitive-file-edit.mjs","timeout":10},{"type":"command","command":"node ${HOOKS_DIR}/tasks-yaml-guard.mjs","timeout":10}]}],"PostToolUse":[{"matcher":"Read|Grep","hooks":[{"type":"command","command":"node ${HOOKS_DIR}/memory-ref-tracker.mjs"},{"type":"command","command":"node ${HOOKS_DIR}/rules-loader.mjs"}]},{"matcher":"Read|Edit|Write|Skill","hooks":[{"type":"command","command":"node ${HOOKS_DIR}/session-activity-tracker.mjs"}]},{"matcher":"Read|Edit","hooks":[{"type":"command","command":"node ${HOOKS_DIR}/cortex-md-injector.mjs"}]}],"PermissionRequest":[{"matcher":"Edit|Write","hooks":[{"type":"command","command":"printf '{\\"hookSpecificOutput\\":{\\"hookEventName\\":\\"PermissionRequest\\",\\"decision\\":{\\"behavior\\":\\"allow\\"}}}'","timeout":5}]}],"SessionStart":[{"matcher":"startup|resume|clear|compact","hooks":[{"type":"command","command":"node ${HOOKS_DIR}/cortex-md-injector.mjs"}]}]}`;

test('buildHooksSettings compiles ordered Claude events from the active registry', () => {
  const entries: HookEntry[] = [
    { id: 'pre-script', event: 'agent:pre-tool', matcher: 'Edit', run: { script: 'first.mjs', timeout: 10 } },
    { id: 'post-command', event: 'agent:post-tool', matcher: 'Read', run: { command: 'post-command' } },
    { id: 'native-pre', event: 'cc:PreToolUse', matcher: 'Edit', run: { command: 'second-pre' } },
    { id: 'pre-without-matcher', event: 'agent:pre-tool', run: { command: 'bare-pre' } },
    { id: 'disabled', event: 'cc:Notification', matcher: 'idle', run: { command: 'disabled' }, enabled: false },
    { id: 'missing-tool', event: 'agent:pre-tool', matcher: 'AskUserQuestion', run: { command: 'missing' }, scope: { requiresTool: 'AskUserQuestion' } },
    { id: 'pi-scoped', event: 'agent:pre-tool', matcher: 'Edit', run: { command: 'pi-only' }, scope: { backends: ['pi'] } },
    { id: 'pi-native', event: 'pi:tool_call', matcher: 'read', run: { command: 'pi-native' } },
    { id: 'server-event', event: 'cortex:thread.start', matcher: {}, run: { command: 'server-event' } },
    { id: 'session-start', event: 'agent:session-start', matcher: 'startup', run: { script: 'start.mjs' } },
    { id: 'notification', event: 'cc:Notification', matcher: 'idle', run: { command: 'notify', timeout: 5 } },
    { id: 'matcherless-stop', event: 'cc:Stop', run: { command: 'stop' } },
  ];
  const expected = `{"PreToolUse":[{"matcher":"Edit","hooks":[{"type":"command","command":"node ${HOOKS_DIR}/first.mjs","timeout":10},{"type":"command","command":"second-pre"}]},{"hooks":[{"type":"command","command":"bare-pre"}]}],"PostToolUse":[{"matcher":"Read","hooks":[{"type":"command","command":"post-command"}]}],"SessionStart":[{"matcher":"startup","hooks":[{"type":"command","command":"node ${HOOKS_DIR}/start.mjs"}]}],"Notification":[{"matcher":"idle","hooks":[{"type":"command","command":"notify","timeout":5}]}],"Stop":[{"hooks":[{"type":"command","command":"stop"}]}]}`;

  withHookRegistry(entries, () => {
    assert.equal(JSON.stringify(buildHooksSettings('Edit,Read')), expected);
  });
});

test('buildHooksSettings serializes native events that collide with Object.prototype', () => {
  const entries: HookEntry[] = [
    { id: 'constructor-event', event: 'cc:constructor', run: { command: 'constructor-hook' } },
    { id: 'proto-event', event: 'cc:__proto__', run: { command: 'proto-hook' } },
  ];
  const expected = '{"constructor":[{"hooks":[{"type":"command","command":"constructor-hook"}]}],"__proto__":[{"hooks":[{"type":"command","command":"proto-hook"}]}]}';

  withHookRegistry(entries, () => {
    assert.equal(JSON.stringify(buildHooksSettings('Bash')), expected);
  });
});

test('buildHooksSettings byte parity — null tools', () => {
  assert.equal(JSON.stringify(buildHooksSettings(null)), GOLDEN_HOOKS_WITH_INTERACTION);
});

test('buildHooksSettings byte parity — interaction tools present', () => {
  const tools = 'Edit,Write,AskUserQuestion,ExitPlanMode';
  assert.equal(JSON.stringify(buildHooksSettings(tools)), GOLDEN_HOOKS_WITH_INTERACTION);
});

test('buildHooksSettings byte parity — interaction tools absent', () => {
  assert.equal(JSON.stringify(buildHooksSettings('Bash,Read,Edit,Write')), GOLDEN_HOOKS_WITHOUT_INTERACTION);
});

test('buildHooksSettings uses the hardcoded table when legacy mode is enabled', () => {
  const entries: HookEntry[] = [
    { id: 'only-notification', event: 'cc:Notification', matcher: 'idle', run: { command: 'notify' } },
  ];
  withHookRegistry(entries, () => {
    process.env.CORTEX_HOOKS_LEGACY = '1';
    assert.equal(
      JSON.stringify(buildHooksSettings('Bash,Read,Edit,Write')),
      GOLDEN_HOOKS_WITHOUT_INTERACTION,
    );
  });
});

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

test('POST_TOOL_USE_HOOKS — includes cortex-md-injector entry for Read and Edit', () => {
  const entry = POST_TOOL_USE_HOOKS.find((h: any) => h.matcher === 'Read|Edit');
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

function compactTestSession(): { session: any; writes: string[]; cleanup: () => void } {
  const session = adapterTest.makeSessionForTest() as any;
  const writes: string[] = [];
  const stream = { write: () => true, end: () => {} };
  session.proc = { stdin: { write: (line: string) => { writes.push(line); return true; } }, exitCode: null };
  session.createTurnStreams = () => ({ rawStream: stream, txtStream: stream });
  return {
    session,
    writes,
    cleanup: () => {
      if (session.idleTimer) clearTimeout(session.idleTimer);
      if (session.turnIdleTimer) clearTimeout(session.turnIdleTimer);
      if (session.maxTimer) clearTimeout(session.maxTimer);
    },
  };
}

function claudeResult(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, session_id: 'test-session',
    total_cost_usd: 0.08, num_turns: 0, result: '', duration_ms: 1, duration_api_ms: 1,
    usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 },
    modelUsage: { 'claude-sonnet-4-5': {} },
    ...overrides,
  });
}

test('Claude print compact sends exact /compact frame and requires compact_boundary', async (t) => {
  const { session, writes, cleanup } = compactTestSession();
  t.onTestFinished(cleanup);
  const promise = session.compact();
  const frame = JSON.parse(writes[0]);
  assert.equal(frame.message.content, '/compact');
  session.handleLine(JSON.stringify({
    type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 64000 },
  }));
  session.handleLine(claudeResult());
  assert.deepEqual(await promise, {
    status: 'compacted', tokensBefore: 64000, estimatedTokensAfter: null, contextUsage: null,
    usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 40, cacheWriteTokens: 30, costUsd: 0.08 },
  });
});

test('Claude print compact maps the local no-history response to not-needed', async (t) => {
  const { session, cleanup } = compactTestSession();
  t.onTestFinished(cleanup);
  const promise = session.compact();
  session.handleLine(JSON.stringify({
    type: 'assistant', message: { content: [{ type: 'text', text: 'Error: No messages to compact' }] },
  }));
  session.handleLine(claudeResult({ total_cost_usd: 0, usage: undefined, modelUsage: undefined }));
  assert.deepEqual(await promise, {
    status: 'not-needed', tokensBefore: null, estimatedTokensAfter: null, contextUsage: null, usage: null,
  });
});

test('Claude print compact rejects an unconfirmed result', async (t) => {
  const { session, cleanup } = compactTestSession();
  t.onTestFinished(cleanup);
  const promise = session.compact();
  session.handleLine(claudeResult());
  await assert.rejects(promise, /did not confirm compaction/i);
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
    '--replay-user-messages',
    '--include-partial-messages',
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
