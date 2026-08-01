// input:  task store, project paths, filesystem, git, task mutation lock
// output: atomically removed and archived completed tasks plus archive commits
// pos:    Scheduled retention job serialized with lifecycle writers
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { PROJECTS_DIR, DATA_DIR } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { type Task } from '@core/task-parser.js';
import {
  readTasks, withTaskFileMutationLock, writeTasks,
} from './system/task-lifecycle-edit.js';
import { taskStore } from './store.js';

const log = createLogger('task-archiver');

const ARCHIVE_AGE_DAYS = 3;

export function isOlderThan(dateStr: string, days: number): boolean {
  const completed = new Date(`${dateStr.slice(0, 10)}T00:00:00Z`);
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  cutoff.setUTCHours(0, 0, 0, 0);
  return completed < cutoff;
}

function formatTaskForArchive(task: Task): string {
  const lines: string[] = [];
  lines.push(`- [x] ${task.text} [id: ${task.id}]`);
  if (task.why) lines.push(`  Why: ${task.why}`);
  if (task.done_when) lines.push(`  Done when: ${task.done_when}`);
  lines.push(`  Priority: ${task.priority}`);
  if (task.completed_at) lines.push(`  Completed: ${task.completed_at}${task.completed_note ? ` (${task.completed_note})` : ''}`);
  return lines.join('\n');
}

function processProjectUnlocked(projectName: string): { project: string; ids: string[] } | null {
  const tasksPath = path.join(PROJECTS_DIR, projectName, 'TASKS.yaml');
  if (!fs.existsSync(tasksPath)) return null;

  const tasks = readTasks(projectName);

  const toArchive: Task[] = [];
  const toKeep: Task[] = [];

  for (const task of tasks) {
    if (task.status === 'done' && task.completed_at && isOlderThan(task.completed_at, ARCHIVE_AGE_DAYS)) {
      toArchive.push(task);
    } else {
      toKeep.push(task);
    }
  }

  if (toArchive.length === 0) return null;

  const archivedIds = toArchive.map((t) => t.id).filter(Boolean);
  log.info(`${projectName}: archiving ${toArchive.length} tasks (${archivedIds.join(', ')})`);

  const archivePath = path.join(PROJECTS_DIR, projectName, 'tasks-archive.md');
  let archiveContent: string;
  if (fs.existsSync(archivePath)) {
    archiveContent = fs.readFileSync(archivePath, 'utf8').trimEnd() + '\n';
  } else {
    archiveContent = `# ${projectName} — Tasks Archive\n\n> Archived completed tasks. Current tasks in TASKS.yaml.\n`;
  }

  for (const task of toArchive) {
    archiveContent += '\n' + formatTaskForArchive(task) + '\n';
  }

  writeTasks(projectName, toKeep);
  fs.writeFileSync(archivePath, archiveContent);

  return { project: projectName, ids: archivedIds };
}

function processProject(projectName: string): { project: string; ids: string[] } | null {
  return withTaskFileMutationLock(projectName, () => processProjectUnlocked(projectName));
}

function gitCommit(results: Array<{ project: string; ids: string[] }>) {
  const files: string[] = [];
  for (const r of results) {
    const projectDir = path.join(PROJECTS_DIR, r.project);
    files.push(path.join(projectDir, 'TASKS.yaml'));
    files.push(path.join(projectDir, 'tasks-archive.md'));
  }

  try {
    const gitArgs = files.map((f) => `"${f}"`).join(' ');
    execSync(`git add ${gitArgs}`, { cwd: DATA_DIR, stdio: 'pipe' });

    const status = execSync('git diff --cached --stat', { cwd: DATA_DIR, encoding: 'utf8' });
    if (!status.trim()) {
      log.info('No changes to commit');
      return;
    }

    const summary = results.map((r) => `${r.project}: ${r.ids.length} tasks`).join('; ');
    const msg = `auto-archive: completed tasks (${summary})`;
    execSync(`git commit -m "${msg}"`, { cwd: DATA_DIR, stdio: 'pipe' });
    log.info(`Committed: ${msg}`);
  } catch (e: any) {
    log.error('Git commit failed:', e.message);
  }
}

async function runTaskArchiver() {
  return taskStore.runExclusive(() => {
    log.info('Starting scan...');
    const results: { archived: Array<{ project: string; ids: string[] }>; skipped: string[]; errors: string[] } = {
      archived: [], skipped: [], errors: [],
    };

    let projectNames: string[];
    try {
      projectNames = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory()).map((d) => d.name);
    } catch (e: any) {
      results.errors.push(`Failed to read projects dir: ${e.message}`);
      return results;
    }

    for (const name of projectNames) {
      try {
        const result = processProject(name);
        if (result) results.archived.push(result);
        else results.skipped.push(name);
      } catch (e: any) {
        results.errors.push(`${name}: ${e.message}`);
        log.error(`Error processing ${name}:`, e.message);
      }
    }

    if (results.archived.length > 0) gitCommit(results.archived);

    const archivedCount = results.archived.reduce((sum, r) => sum + r.ids.length, 0);
    log.info(`Done. Archived ${archivedCount} tasks from ${results.archived.length} project(s)`);
    return results;
  });
}

export { runTaskArchiver };
