import { describe, expect, it } from 'vitest';
import type { ThreadChildNode } from '@cortex-agent/ui-contract';
import {
  MAX_LEVEL,
  nodeLevel,
  treeMaxLevel,
} from './nested-threads';

// Build a ThreadChildNode with only the fields the pure logic touches.
function node(
  id: string,
  depth: number,
  children: ThreadChildNode[] = [],
  opts: Partial<ThreadChildNode> = {},
): ThreadChildNode {
  return {
    id,
    templateName: opts.templateName ?? 'coder-review',
    status: opts.status ?? 'running',
    activeAgent: opts.activeAgent ?? null,
    costUsd: opts.costUsd ?? 0,
    depth,
    createdAt: opts.createdAt ?? '2026-07-06T00:00:00.000Z',
    taskId: opts.taskId ?? null,
    children,
    truncated: opts.truncated ?? false,
  };
}

describe('nodeLevel', () => {
  it('maps direct child (depth 0) to level 2 — the root thread is level 1', () => {
    expect(nodeLevel(node('a', 0))).toBe(2);
  });
  it('maps depth 3 to level 5', () => {
    expect(nodeLevel(node('a', 3))).toBe(5);
  });
});

describe('treeMaxLevel', () => {
  it('is 1 (root only) for an empty subthread tree', () => {
    expect(treeMaxLevel([])).toBe(1);
  });
  it('reflects the deepest node, mapped to a level', () => {
    // deepest node depth 2 → level 4
    const tree = [node('a', 0, [node('b', 1, [node('c', 2)])])];
    expect(treeMaxLevel(tree)).toBe(4);
  });
  it('never exceeds MAX_LEVEL even if the backend nests deeper', () => {
    const tree = [node('a', 0, [node('b', 1, [node('c', 2, [node('d', 3, [node('e', 4)])])])])];
    expect(treeMaxLevel(tree)).toBe(MAX_LEVEL);
  });
});
