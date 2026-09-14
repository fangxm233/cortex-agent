import type { TaskInfo } from '@cortex-agent/ui-contract';

export function unresolvedDependencyIds(
  task: TaskInfo,
  statusById?: ReadonlyMap<string, TaskInfo['status']>,
): string[] {
  if (task.unmetDependencyIds !== undefined) return task.unmetDependencyIds;
  if (!statusById) return task.dependsOn;
  return task.dependsOn.filter((dependency) => statusById.get(dependency) === 'open');
}
