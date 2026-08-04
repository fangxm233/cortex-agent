// input:  a compiled benchmark policy guard, a lease state, a PI-native tool name
// output: a fail-closed allow/deny decision for PI's tool-dispatch boundary
// pos:    PI application point of the mandatory benchmark policy guard
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

/** Serialized compiled guard for this role. Its presence — even empty — puts the PI process in
 *  guarded mode, where no branch may return allow by default (design §13 GT6, §6.8 G3). */
export const PI_POLICY_GUARD_ENV = 'CORTEX_PI_POLICY_GUARD';
/** The guard's lease-state input (§6.8 G4). */
export const PI_LEASE_STATE_ENV = 'CORTEX_PI_LEASE_STATE';
/** Resolved MCP composition for this spawn; the bridge derives its server set from it (§5.6 P1). */
export const PI_MCP_COMPOSITION_ENV = 'CORTEX_PI_MCP_COMPOSITION';

/** D-GUARD-STATIC: Gate 2 lands the guard mechanism, not the lease transition, so the state is a
 *  constant the factory supplies. Gates 3/6/7 vary this same parameter without reshaping the guard. */
export const GATE2_LEASE_STATE = 'parent-writable';

export interface GuardDecision {
  allow: boolean;
  reason: string;
}

export type PolicyGuardEvaluator = (toolName: string, leaseState: string) => GuardDecision;

function deny(reason: string): GuardDecision {
  return { allow: false, reason };
}

function allowList(value: unknown, state: string): Set<string> {
  if (!Array.isArray(value) || value.some(name => typeof name !== 'string' || name.length === 0)) {
    throw new Error(`policy guard state '${state}' must be an array of tool names`);
  }
  return new Set(value as string[]);
}

/**
 * Read a compiled guard as the per-lease-state allow-list of §6.6, in PI-native names. Throws on
 * anything else: an unreadable guard must not be turned into a permissive one.
 */
export function compilePiPolicyGuard(raw: unknown): PolicyGuardEvaluator {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('policy guard must be an object keyed by lease state');
  }
  const table = new Map<string, Set<string>>();
  for (const [state, value] of Object.entries(raw as Record<string, unknown>)) {
    table.set(state, allowList(value, state));
  }
  return (toolName, leaseState) => {
    const allowed = table.get(leaseState);
    if (allowed === undefined) return deny(`no allow-list for lease state '${leaseState}'`);
    return allowed.has(toolName)
      ? { allow: true, reason: `'${toolName}' is allow-listed in '${leaseState}'` }
      : deny(`'${toolName}' is not allow-listed in '${leaseState}'`);
  };
}

/**
 * The decision every guarded PI tool dispatch goes through. A missing evaluator, an evaluator that
 * throws and an evaluator that answers with anything other than an explicit allow all deny — there
 * is deliberately no branch here that yields allow without one (§6.8 G3, battery T8).
 */
export function guardDecision(
  evaluator: PolicyGuardEvaluator | null,
  toolName: string,
  leaseState: string,
): GuardDecision {
  if (evaluator === null) return deny('no benchmark policy guard is installed');
  try {
    const decision = evaluator(toolName, leaseState);
    if (!decision || decision.allow !== true) {
      return deny(decision?.reason ?? 'guard returned no decision');
    }
    return decision;
  } catch (error) {
    return deny(`guard evaluation failed: ${(error as Error).message}`);
  }
}

export interface PiToolGate {
  /** True when the benchmark policy guard governs this process. */
  readonly guarded: boolean;
  decide(nativeToolName: string, claudeLabel?: string): GuardDecision;
}

/** Match Claude-native labels against the active agent's comma-separated allowlist. Unguarded
 *  daemon sessions only; a benchmark spawn never reaches it (see `resolvePiToolGate`). */
function legacyAllowlistGate(allowedToolsEnv: string | undefined): PiToolGate {
  const allowAll = !allowedToolsEnv || allowedToolsEnv.trim() === '';
  const allowed = new Set(
    (allowedToolsEnv ?? '').split(',').map(tool => tool.trim()).filter(Boolean),
  );
  return {
    guarded: false,
    decide: (nativeToolName, claudeLabel) => {
      if (allowAll) return { allow: true, reason: 'no allowlist configured' };
      const label = claudeLabel ?? nativeToolName;
      return allowed.has(label)
        ? { allow: true, reason: `'${label}' is allow-listed` }
        : deny(`'${label}' is not allow-listed`);
    },
  };
}

/** The guarded gate every benchmark PI process runs under. Exported so a caller can install an
 *  evaluator that is not env-derived; the decision path is the same `guardDecision` either way. */
export function benchmarkToolGate(
  evaluator: PolicyGuardEvaluator | null,
  leaseState: string,
): PiToolGate {
  return {
    guarded: true,
    decide: nativeToolName => guardDecision(evaluator, nativeToolName, leaseState),
  };
}

function guardedGate(serialized: string, leaseState: string | undefined): PiToolGate {
  let evaluator: PolicyGuardEvaluator;
  try {
    evaluator = compilePiPolicyGuard(JSON.parse(serialized) as unknown);
  } catch (error) {
    // Guarded mode with an unreadable guard: deny, never fall back to the allowlist gate.
    const reason = `benchmark policy guard is unreadable: ${(error as Error).message}`;
    evaluator = () => deny(reason);
  }
  return benchmarkToolGate(evaluator, leaseState ?? '');
}

/**
 * Pick the gate this PI process runs under. The selection is total and ordered: a guard present in
 * the environment always wins, and the guarded branch never falls through to the allowlist gate.
 * That is what removes §6.6 defect 4 — the empty-value allow-all — from the benchmark path.
 */
export function resolvePiToolGate(env: NodeJS.ProcessEnv): PiToolGate {
  const serialized = env[PI_POLICY_GUARD_ENV];
  if (serialized === undefined) return legacyAllowlistGate(env.CORTEX_PI_ALLOWED_TOOLS);
  return guardedGate(serialized, env[PI_LEASE_STATE_ENV]);
}
