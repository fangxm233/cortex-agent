// input:  thread ids, buffered input ids, preparation promises
// output: readiness registration, snapshot waits, eviction release
// pos:    Coordinates asynchronous thread-input preparation
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

interface ReadinessGate {
  ready: Promise<void>;
  release: () => void;
}

const gatesByThread = new Map<string, Map<string, ReadinessGate>>();

function releaseGate(threadId: string, inputId: string): void {
  const gates = gatesByThread.get(threadId);
  const gate = gates?.get(inputId);
  if (!gates || !gate) return;
  gates.delete(inputId);
  gate.release();
  if (gates.size === 0) gatesByThread.delete(threadId);
}

export function registerPendingUserInput(
  threadId: string,
  inputId: string,
  preparation: Promise<void>,
): void {
  evictPendingUserInput(threadId, inputId);
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const gates = gatesByThread.get(threadId) ?? new Map<string, ReadinessGate>();
  gates.set(inputId, { ready, release });
  gatesByThread.set(threadId, gates);
  void preparation.catch(() => {}).finally(() => releaseGate(threadId, inputId));
}

export function evictPendingUserInput(threadId: string, inputId: string): void {
  releaseGate(threadId, inputId);
}

export async function waitForPendingUserInputs(threadId: string, inputIds: string[]): Promise<void> {
  const gates = gatesByThread.get(threadId);
  if (!gates) return;
  const waits = inputIds.flatMap((inputId) => {
    const gate = gates.get(inputId);
    return gate ? [gate.ready] : [];
  });
  await Promise.all(waits);
}
