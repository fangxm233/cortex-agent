import { getDefaultCortexInjector, type CortexMDEntry } from '../../memory/cortex-md-injector.js';

export { type CortexMDEntry };

/** Build text content blocks for the CORTEX.md chain returned by cortex-client.
 *  Dedup by (device:path) mtime via CortexMDInjector — each CORTEX.md is injected
 *  at most once per MCP process, and the cache is disk-backed so restarts
 *  don't re-flood the agent with the same instructions.
 *
 *  If `targetFilePath` is supplied and equals one of the chain entries (i.e. the
 *  tool is reading/writing/editing a CORTEX.md itself), that entry is marked as
 *  seen in the cache but its block is suppressed — the agent already receives
 *  the content as the primary tool response, so re-injecting would just double
 *  it. Subsequent reads of sibling files in the same dir will then hit the
 *  cache and also skip, matching the normal dedup behavior. */
export function cortexMDContentBlocks(
  device: string,
  entries: CortexMDEntry[] | undefined,
  targetFilePath?: string,
): Array<{ type: 'text'; text: string }> {
  if (!entries || entries.length === 0) return [];
  let markOnly: Set<string> | undefined;
  if (targetFilePath) {
    const matched = entries.filter(e => pathsEqualForMarking(e.path, targetFilePath));
    if (matched.length > 0) markOnly = new Set(matched.map(e => e.path));
  }
  return getDefaultCortexInjector().buildBlocks(device, entries, markOnly);
}

/** Tolerant path equality for matching tool `file_path` against scanner-produced
 *  entry paths. The scanner runs on the remote device (Linux or Windows), so
 *  separators may differ. We compare directly and with both separators
 *  normalized to forward slashes. Case-sensitive — Windows remotes reading
 *  through differently-cased paths will just not mark (graceful degrade to the
 *  pre-existing duplicate-on-first-read behavior). */
function pathsEqualForMarking(a: string, b: string): boolean {
  if (a === b) return true;
  return a.replace(/\\/g, '/') === b.replace(/\\/g, '/');
}
