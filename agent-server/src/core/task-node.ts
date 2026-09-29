// Task-node (composite/manager task) filesystem locations — DR-0017 W1.

import { mkdirSync, writeFileSync, existsSync } from 'fs';
import * as path from 'path';
import { PROJECTS_DIR } from './paths.js';

/** Durable home of a composite task node: context/projects/{project}/manager/{taskId}/. */
export function managerNodeDir(project: string, taskId: string): string {
  return path.join(PROJECTS_DIR, project, 'manager', taskId);
}

/** The task-keyed manager artifact (truth layer for checkpoints — DR-0017 D2). */
export function taskArtifactPath(project: string, taskId: string): string {
  return path.join(managerNodeDir(project, taskId), 'artifact.md');
}

/** Create the node dir + artifact if missing. NEVER truncates an existing artifact —
 *  a new manager incarnation must inherit the previous checkpoint (rotation/rehydration). */
export function ensureTaskArtifact(project: string, taskId: string): string {
  mkdirSync(managerNodeDir(project, taskId), { recursive: true });
  const p = taskArtifactPath(project, taskId);
  if (!existsSync(p)) writeFileSync(p, '');
  return p;
}
