// input:  thread metadata, persisted parent lookup, evidence parser
// output: canonical root or inherited descendant metadata
// pos:    Enforces immutable benchmark context inheritance
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { isDeepStrictEqual } from 'node:util';
import { parseProductionBenchmarkEvidenceContext } from '@core/production-benchmark-evidence.js';
import type { ThreadMetadata, ThreadRecord } from '@core/types/thread-types.js';

function canonicalMetadata(metadata: ThreadMetadata | null | undefined): ThreadMetadata {
  const resolved = { ...(metadata ?? {}) };
  const evidence = resolved.productionBenchmarkEvidenceContext;
  if (evidence != null) {
    resolved.productionBenchmarkEvidenceContext = parseProductionBenchmarkEvidenceContext(evidence);
  }
  return resolved;
}

function inheritParentMetadata(metadata: ThreadMetadata, parent: ThreadRecord): ThreadMetadata {
  const rootThreadId = parent.metadata?.rootThreadId ?? parent.id;
  if (metadata.rootThreadId && metadata.rootThreadId !== rootThreadId) {
    throw new Error('Production descendant root thread identity conflicts with persisted parent');
  }
  metadata.rootThreadId = rootThreadId;
  const parentEvidence = parent.metadata?.productionBenchmarkEvidenceContext;
  const childEvidence = metadata.productionBenchmarkEvidenceContext;
  if (parentEvidence == null) {
    if (childEvidence != null) throw new Error('Production benchmark descendant context conflicts with persisted parent');
    return metadata;
  }
  const inherited = parseProductionBenchmarkEvidenceContext(parentEvidence);
  if (childEvidence != null && !isDeepStrictEqual(childEvidence, inherited)) {
    throw new Error('Production benchmark descendant context conflicts with persisted parent');
  }
  metadata.productionBenchmarkEvidenceContext = inherited;
  return metadata;
}

export function resolveThreadEvidenceMetadata(
  metadata: ThreadMetadata | null | undefined,
  getParent: (threadId: string) => ThreadRecord | null,
): ThreadMetadata {
  const resolved = canonicalMetadata(metadata);
  const parentThreadId = resolved.parentThreadId;
  if (!parentThreadId) return resolved;
  const parent = getParent(parentThreadId);
  if (!parent) throw new Error(`Production descendant parent thread is missing: ${parentThreadId}`);
  return inheritParentMetadata(resolved, parent);
}
