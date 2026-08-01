// input:  task files and cross-process mutation locks
// output: collision-safe task ID generation, assignment, and validation
// pos:    Assigns IDs without overwriting concurrent task lifecycle changes
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECTS_DIR, listProjectDirs } from '@core/utils.js';
import { parseTasksFile } from '@core/task-parser.js';
import {
  readTasks, taskFileProjects, withTaskFileMutationLocks, writeTasks,
} from './task-lifecycle-edit.js';

function generateHash(existingHashes: Set<string> = new Set()): string {
  while (true) {
    const hash = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
    if (!existingHashes.has(hash)) return hash;
  }
}

function collectAllExistingHashes(): Set<string> {
  const allHashes = new Set<string>();
  if (!fs.existsSync(PROJECTS_DIR)) return allHashes;
  for (const projectName of listProjectDirs()) {
    const tasksPath = path.join(PROJECTS_DIR, projectName, 'TASKS.yaml');
    if (!fs.existsSync(tasksPath)) continue;
    const tasks = parseTasksFile(fs.readFileSync(tasksPath, 'utf8'), projectName);
    for (const t of tasks) {
      if (t.id) allHashes.add(t.id);
    }
  }
  return allHashes;
}

function assignIdsUnlocked(project: string | null = null) {
  if (!fs.existsSync(PROJECTS_DIR)) {
    return { success: false, message: 'Projects directory not found' };
  }

  let totalAssigned = 0;
  const allHashes = collectAllExistingHashes();
  const projects = project ? [project] : listProjectDirs();
  for (const projectName of projects) {
    const tasksPath = path.join(PROJECTS_DIR, projectName, 'TASKS.yaml');
    if (!fs.existsSync(tasksPath)) continue;
    const tasks = readTasks(projectName);
    let modified = false;
    for (const task of tasks) {
      if (!task.id || task.id === '') {
        const hash = generateHash(allHashes);
        allHashes.add(hash);
        task.id = hash;
        modified = true;
        totalAssigned += 1;
      }
    }
    if (modified) {
      writeTasks(projectName, tasks);
    }
  }
  return { success: true, message: `Assigned ${totalAssigned} task ID(s)`, assigned: totalAssigned };
}

function validateIds() {
  if (!fs.existsSync(PROJECTS_DIR)) {
    return { success: false, message: 'Projects directory not found' };
  }

  const idToProjects = new Map<string, string[]>();
  for (const projectName of listProjectDirs()) {
    const tasksPath = path.join(PROJECTS_DIR, projectName, 'TASKS.yaml');
    if (!fs.existsSync(tasksPath)) continue;
    const tasks = parseTasksFile(fs.readFileSync(tasksPath, 'utf8'), projectName);
    for (const task of tasks) {
      if (!task.id) continue;
      const existing = idToProjects.get(task.id) || [];
      existing.push(projectName);
      idToProjects.set(task.id, existing);
    }
  }

  const collisions: { id: string; projects: string[] }[] = [];
  for (const [hash, projects] of idToProjects) {
    if (projects.length > 1) collisions.push({ id: hash, projects });
  }

  if (collisions.length === 0) {
    return { success: true, message: `No collisions found (${idToProjects.size} unique IDs across all projects)`, collisions: [] };
  }
  return { success: false, message: `Found ${collisions.length} cross-project ID collision(s)`, collisions };
}

function assignIds(project: string | null = null) {
  const projects = project ? [project] : taskFileProjects();
  return withTaskFileMutationLocks(projects, () => assignIdsUnlocked(project));
}

export { assignIds, collectAllExistingHashes, generateHash, validateIds };
