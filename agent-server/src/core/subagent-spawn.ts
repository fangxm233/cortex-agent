// Native subagent vocabulary shared by the backends that report it, the transcript and the
// platform tool trace: which tool calls spawn a subagent, the child each call names, and the
// attribution a subagent's own events carry.

/** Native subagent tool spellings: current Claude, historical Claude, and PI respectively. */
export const SUBAGENT_SPAWN_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task', 'agent']);

export interface SubagentSpawnRef {
  id: string;
  type?: string;
  description?: string;
  /** Exact prompt value supplied by the main agent, preserving whitespace and newlines. */
  prompt: string;
  requestedModel?: string;
}

function spawnRef(task: Record<string, unknown>, id: string): SubagentSpawnRef {
  return {
    id,
    ...(typeof task.subagent_type === 'string' ? { type: task.subagent_type } : {}),
    ...(typeof task.description === 'string' ? { description: task.description } : {}),
    prompt: typeof task.prompt === 'string' ? task.prompt : '',
    ...(typeof task.model === 'string' ? { requestedModel: task.model } : {}),
  };
}

function piTaskEntries(input: Record<string, unknown>): Array<{ task: Record<string, unknown>; index: number }> {
  const batch = Array.isArray(input.parallel) ? input.parallel : [input];
  if (Array.isArray(input.chain)) {
    const first = input.chain[0];
    if (!first || typeof first !== 'object' || Array.isArray(first)) return [];
    const task = first as Record<string, unknown>;
    const prompt = typeof task.prompt === 'string' ? task.prompt.replace(/\{previous\}/g, '') : '';
    return [{ task: { ...task, prompt }, index: 0 }];
  }
  return batch.flatMap((task, index) => (
    task && typeof task === 'object' && !Array.isArray(task)
      ? [{ task: task as Record<string, unknown>, index }]
      : []
  ));
}

/** Extract every child represented by one main-agent spawn call without exposing other tool args. */
export function subagentSpawnsFromToolCall(
  name: string, input: unknown, toolUseId: string,
): SubagentSpawnRef[] {
  if (!SUBAGENT_SPAWN_TOOLS.has(name) || !toolUseId || !input || typeof input !== 'object' || Array.isArray(input)) return [];
  const record = input as Record<string, unknown>;
  if (name !== 'agent') return [spawnRef(record, toolUseId)];
  return piTaskEntries(record).map(({ task, index }) => spawnRef(task, `${toolUseId}#${index}`));
}

/**
 * Attribution for a tool call issued by a native subagent rather than the main agent.
 *
 * Absent on the main agent's own calls — that absence is the discriminator every consumer uses.
 * The CLI already puts this linkage on the wire, so nothing is added to any tool's parameter
 * schema and no prompt changes: the model never sees or reports it.
 *
 * `parentToolUseId` is the `Agent`/`Task` call that spawned the subagent, and is null when the
 * source can only attest THAT it was a subagent without naming the parent. Consumers that need
 * per-subagent attribution must therefore tolerate a null parent, not assume one.
 */
export interface ToolUseSubagent {
  parentToolUseId: string | null;
  /** Exact runtime prompt, reported once when a PI chain child actually starts. */
  prompt?: string | null;
  /** Declared subagent type (e.g. `explore`), when the source reports one. */
  type: string | null;
  /** The spawning call's task description, when the source reports one. Reads far better than the
   *  truncated prompt fragment a consumer would otherwise scrape off the parent's tool input. */
  description?: string | null;
  /** The model that produced this message. There is no `subagent_model` on the wire — the CLI's
   *  assistant event extends the base message with only `subagent_type` and `task_description` —
   *  so this is `message.model`, i.e. whatever actually answered. Null on `user`-envelope events
   *  (tool results carry no message) and on the spawning call itself, which happens before the
   *  subagent has said anything. Consumers fill it in from whichever event reports it first. */
  model?: string | null;
}

export function subagentSpawnFromAttribution(subagent: ToolUseSubagent): SubagentSpawnRef | null {
  if (!subagent.prompt) return null;
  return {
    id: subagent.parentToolUseId || 'sidechain',
    ...(subagent.type ? { type: subagent.type } : {}),
    ...(subagent.description ? { description: subagent.description } : {}),
    prompt: subagent.prompt,
  };
}
