// input:  Task dependency ids and optional scoped status lookup
// output: Authoritative or locally resolved unmet dependency ids
// pos:    Shared task dependency display and grouping helper
// >>> If I am updated, update my header comment and CORTEX.md <<<

import type { TaskInfo } from '@cortex-agent/ui-contract';

export function unresolvedDependencyIds(
  task: TaskInfo,
  statusById?: ReadonlyMap<string, TaskInfo['status']>,
): string[] {
  if (task.unmetDependencyIds !== undefined) return task.unmetDependencyIds;
  if (!statusById) return task.dependsOn;
  return task.dependsOn.filter((dependency) => statusById.get(dependency) === 'open');
}
