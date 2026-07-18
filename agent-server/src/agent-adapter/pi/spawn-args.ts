// input:  PISpawnOptions (session/prompt/skill/extension paths)
// output: buildSpawnArgs(opts) → pi CLI argv string[]
// pos:    Pure function to construct pi CLI arguments
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

export interface PISpawnOptions {
  sessionDir: string;
  /** Session UUID for --session flag.  PI scans --session-dir to find the matching file
   *  by filename or internal session id field — no need for the full file path. */
  sessionId?: string | null;
  /** @deprecated Full path to an existing PI session JSONL file.  Prefer sessionId
   *  which lets PI handle session lookup internally.  Kept for backward compat. */
  sessionPath?: string | null;
  /** Model identifier (e.g. "deepseek-v4-flash[1m]"); context-window suffix is stripped. */
  model?: string | null;
  /** PI provider name (e.g. "anthropic", "deepseek", "openai-codex"). When set together with model,
   *  emits `--provider <name>`. When omitted, PI infers provider from model name prefix or its default.
   *  Sourced from the cortex profile's `mode` field at adapter-spawn time. */
  provider?: string | null;
  systemPrompt?: string | null;
  /** Single string or multi-value array; pi args.js:49-51 accepts repeated --append-system-prompt flags. */
  appendSystemPrompt?: string | string[] | null;
  pluginDirs?: string[] | null;
  /** PI extension file paths; each emits a repeated --extension flag (pi args.js:95-98). */
  extensionPaths?: string[] | null;
  /** Thinking level from the profile's `thinking` field → `--thinking <level>`
   *  (off/minimal/low/medium/high/xhigh). Absent → no flag. */
  thinking?: string | null;
  /** Extra CLI options from profile (e.g. {"--thinking": "xhigh"}). */
  extraOption?: Record<string, string> | null;
}

/** Strip context-window suffix like "[1m]" from model strings (e.g. "deepseek-v4-flash[1m]" → "deepseek-v4-flash"). */
function stripModelSuffix(model: string): string {
  return model.replace(/\[.*?\]$/, '');
}

export function buildSpawnArgs(opts: PISpawnOptions): string[] {
  const args: string[] = ['--mode', 'rpc', '--session-dir', opts.sessionDir];

  if (opts.model) {
    const cleaned = stripModelSuffix(opts.model);
    args.push('--model', cleaned);
    // Provider is decided by the active cortex profile (mode field). For non-Claude PI providers
    // (deepseek / openai-codex / etc.) cortex writes a multi-provider models.json (writeProvidersConfig)
    // that overrides each provider's baseUrl to the gateway, then PI selects the matching provider here.
    if (opts.provider) {
      args.push('--provider', opts.provider);
    }
  }

  // --session accepts both a UUID (scanned from --session-dir) and a full file path.
  // Prefer sessionId (UUID) — it's robust to PI's internal file naming which may
  // differ from the session UUID.
  if (opts.sessionId && opts.sessionId.length > 0) {
    args.push('--session', opts.sessionId);
  } else if (opts.sessionPath && opts.sessionPath.length > 0) {
    args.push('--session', opts.sessionPath);
  }

  if (opts.systemPrompt && opts.systemPrompt.length > 0) {
    args.push('--system-prompt', opts.systemPrompt);
  }

  if (opts.appendSystemPrompt) {
    const values = Array.isArray(opts.appendSystemPrompt)
      ? opts.appendSystemPrompt
      : [opts.appendSystemPrompt];
    for (const v of values) {
      if (v.length > 0) args.push('--append-system-prompt', v);
    }
  }

  if (opts.pluginDirs) {
    for (const dir of opts.pluginDirs) {
      args.push('--skill', dir);
    }
  }

  if (opts.extensionPaths) {
    for (const ext of opts.extensionPaths) {
      args.push('--extension', ext);
    }
  }

  // Before extraOption so an explicit extraOption {"--thinking": ...} still wins (CLI last-wins).
  if (opts.thinking) {
    args.push('--thinking', opts.thinking);
  }

  if (opts.extraOption) {
    for (const [k, v] of Object.entries(opts.extraOption)) args.push(k, v);
  }

  return args;
}
