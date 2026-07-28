// input:  recursive thread-child DTOs
// output: display levels and bounded maximum tree depth
// pos:    Shared nested-thread depth model
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
//
// Level model: the focused thread on the detail page is level 1; a direct subthread
// (backend depth 0) is level 2, and so on — so `level = node.depth + 2`. The backend caps
// its child tree at depth 4 and flags nodes whose deeper children were cut as `truncated`;
// a truncated node (or a node already at the max level) is "max" — you drill into it (a
// fresh threads.get re-rooted on that thread) to see below, rather than expanding in place.

import type { ThreadChildNode } from '@cortex-agent/ui-contract';

/** The focused thread (level 1) plus ≤4 descendant levels = 5 total. */
export const MAX_LEVEL = 5;

/** Display level of a child node: root=1, direct child (depth 0)=2. */
export function nodeLevel(node: ThreadChildNode): number {
  return node.depth + 2;
}

/** Deepest level present in the subthread tree (root=1 when empty), capped at MAX_LEVEL. */
export function treeMaxLevel(children: ThreadChildNode[]): number {
  let max = 1;
  const walk = (nodes: ThreadChildNode[]) => {
    for (const n of nodes) {
      if (nodeLevel(n) > max) max = nodeLevel(n);
      walk(n.children);
    }
  };
  walk(children);
  return Math.min(max, MAX_LEVEL);
}
