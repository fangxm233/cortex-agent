// input:  Backend type from types.ts
// output: Capability enum + CAPABILITIES_BY_BACKEND matrix
// pos:    Capability declaration matrix per backend
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { Backend } from './types.js';

export enum Capability {
  Hooks = 'hooks',
  Plugins = 'plugins',
  MCP = 'mcp',
  PlanMode = 'plan-mode',
  AskUserQuestion = 'ask-user-question',
  SystemPromptOverride = 'system-prompt-override',
  SessionResume = 'session-resume',
  ToolAllowlist = 'tool-allowlist',
  StreamingDeltas = 'streaming-deltas',
  MidTurnInject = 'mid-turn-inject',
}

// Claude: full native support (claude-bridge.ts currently wires all eight; DR-0008 §3.2).
// StreamingDeltas: `--include-partial-messages` token-level output (K-010 §11).
// MidTurnInject: print mode accepts a user message on stdin while a turn is in flight (K-010 §8/§9).
const CLAUDE_CAPS: Capability[] = [
  Capability.Hooks,
  Capability.Plugins,
  Capability.MCP,
  Capability.PlanMode,
  Capability.AskUserQuestion,
  Capability.SystemPromptOverride,
  Capability.SessionResume,
  Capability.ToolAllowlist,
  Capability.StreamingDeltas,
  Capability.MidTurnInject,
];

// Codex: per DR-0008 §3.4 table — MCP via existing buildMcpBlock in codex-bridge.ts; --system-prompt + resume via app-server RPC; no Hooks/Plugins/PlanMode/AskUserQuestion/ToolAllowlist
const CODEX_CAPS: Capability[] = [
  Capability.MCP,
  Capability.SystemPromptOverride,
  Capability.SessionResume,
];

// PI: per DR-0008 §5.1 capability matrix — --skill for Plugins, --system-prompt for SystemPromptOverride, tool-allowlist via adapter;
// MCP enabled by mcp-bridge.ts extension (task 5754): auto-injected via --extension in PIAdapter.spawn();
// PlanMode/AskUserQuestion: implemented via tool-shims.ts pseudo-tools + extension_ui_response routing (Phase 2 §S3, 2026-04-27);
// SessionResume: S2 spike confirmed --session <path> resume works (DR-0008 §8 gate ticked, task 7ca9).
// Hooks via PI extension bridge per §3.5 — capability declared true because the extension is part of the default PI adapter package.
const PI_CAPS: Capability[] = [
  Capability.Hooks,
  Capability.Plugins,
  Capability.MCP,
  Capability.PlanMode,
  Capability.AskUserQuestion,
  Capability.SystemPromptOverride,
  Capability.ToolAllowlist,
  Capability.SessionResume,
  Capability.StreamingDeltas,
];

export const CAPABILITIES_BY_BACKEND: Record<Backend, Set<Capability>> = {
  claude: new Set(CLAUDE_CAPS),
  codex: new Set(CODEX_CAPS),
  pi: new Set(PI_CAPS),
};
