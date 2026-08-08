// Task-node (composite/manager task) filesystem locations — DR-0017 W1.
// input:  core/paths PROJECTS_DIR, overridable per call to the trial root (§7.2 P5)
// output: managerNodeDir / taskArtifactPath / ensureTaskArtifact
// pos:    zero-dependency core layer so both domain/threads and domain/tasks can import
//         these without a layer cycle. task = persistent work node; thread = ephemeral
//         execution attempt — the node's durable state (artifact.md checkpoint,
//         ledger.json acceptance record) lives under the project context dir and
//         survives any thread death, rotation, or server restart.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { mkdirSync, writeFileSync, existsSync } from 'fs';
import * as path from 'path';
import { PROJECTS_DIR } from './paths.js';

/** Durable home of a composite task node: context/projects/{project}/manager/{taskId}/.
 *  `projectsRoot` repoints the ambient `PROJECTS_DIR` root at the trial root (§7.2 P5): the P5
 *  port implementation passes the trial root, so an in-trial artifact can never resolve under
 *  the host project dir. Callers that omit it keep the shipped daemon root verbatim. */
export function managerNodeDir(project: string, taskId: string, projectsRoot: string = PROJECTS_DIR): string {
  return path.join(projectsRoot, project, 'manager', taskId);
}

/** The task-keyed manager artifact (truth layer for checkpoints — DR-0017 D2). */
export function taskArtifactPath(project: string, taskId: string, projectsRoot: string = PROJECTS_DIR): string {
  return path.join(managerNodeDir(project, taskId, projectsRoot), 'artifact.md');
}

/** Create the node dir + artifact if missing. NEVER truncates an existing artifact —
 *  a new manager incarnation must inherit the previous checkpoint (rotation/rehydration). */
export function ensureTaskArtifact(project: string, taskId: string, projectsRoot: string = PROJECTS_DIR): string {
  mkdirSync(managerNodeDir(project, taskId, projectsRoot), { recursive: true });
  const p = taskArtifactPath(project, taskId, projectsRoot);
  if (!existsSync(p)) writeFileSync(p, '');
  return p;
}
