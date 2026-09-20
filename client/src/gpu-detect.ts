// input:  nvidia-smi on PATH (child_process)
// output: detectGpuCount() → number | null, cache reset hook for tests
// pos:    Client-side GPU inventory probe, reported to the server on hello
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
import { execFileSync } from 'node:child_process';

/** Above this a parsed number is treated as garbage rather than a machine with that many GPUs. */
const MAX_PLAUSIBLE_GPUS = 64;

const SMI_TIMEOUT_MS = 5000;

export type SmiRunner = () => string;

function runNvidiaSmi(): string {
  return execFileSync('nvidia-smi', ['--query-gpu=count', '--format=csv,noheader'], {
    timeout: SMI_TIMEOUT_MS,
    stdio: 'pipe',
    encoding: 'utf-8',
  });
}

/** Only successful probes are cached: the GPU inventory is fixed for the life of the process,
 *  while a failure may just mean the driver was not up yet when the client started. */
let cached: number | null = null;

/**
 * GPU count for this machine, or `null` when it cannot be established.
 *
 * `null` means "unknown", NOT "zero GPUs" — the server keeps its configured value in that case,
 * so a missing nvidia-smi or a driver hiccup never silently takes a machine out of GPU dispatch.
 * `nvidia-smi --query-gpu=count` prints the host total once per GPU, so only the first line matters.
 */
export function detectGpuCount(run: SmiRunner = runNvidiaSmi): number | null {
  if (cached !== null) return cached;
  let raw: string;
  try {
    raw = run();
  } catch {
    return null;
  }
  const count = Number.parseInt(raw.split('\n')[0]?.trim() ?? '', 10);
  if (!Number.isInteger(count) || count < 0 || count > MAX_PLAUSIBLE_GPUS) return null;
  cached = count;
  return count;
}

export function resetGpuCountCacheForTesting(): void {
  cached = null;
}
