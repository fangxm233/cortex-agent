import * as fs from 'fs';
import * as path from 'path';
import { runFile } from '@core/exec-async.js';
import { PROJECTS_DIR, DATA_DIR } from '@core/utils.js';
import { createLogger } from '@core/log.js';
import { type Task } from '@core/task-parser.js';
import {
  readTasks, withTaskFileMutationLockAsync, writeTasks,
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

async function processProject(projectName: string): Promise<{ project: string; ids: string[] } | null> {
  return withTaskFileMutationLockAsync(projectName, async () => processProjectUnlocked(projectName));
}

async function gitCommit(results: Array<{ project: string; ids: string[] }>): Promise<void> {
  const files: string[] = [];
  for (const r of results) {
    const projectDir = path.join(PROJECTS_DIR, r.project);
    files.push(path.join(projectDir, 'TASKS.yaml'));
    files.push(path.join(projectDir, 'tasks-archive.md'));
  }

  try {
    // Async git (was execSync): this job runs inside the shared server process.
    const added = await runFile('git', ['add', ...files], { cwd: DATA_DIR, timeoutMs: 10000 });
    if (!added.ok) {
      log.error('Git add failed:', (added.stderr || added.error || '').trim());
      return;
    }

    const status = await runFile('git', ['diff', '--cached', '--stat'], { cwd: DATA_DIR, timeoutMs: 5000 });
    if (!status.ok || !status.stdout.trim()) {
      log.info('No changes to commit');
      return;
    }

    const summary = results.map((r) => `${r.project}: ${r.ids.length} tasks`).join('; ');
    const msg = `auto-archive: completed tasks (${summary})`;
    const committed = await runFile('git', ['commit', '-m', msg], { cwd: DATA_DIR, timeoutMs: 10000 });
    if (!committed.ok) {
      log.error('Git commit failed:', (committed.stderr || committed.stdout || '').trim());
      return;
    }
    log.info(`Committed: ${msg}`);
  } catch (e: any) {
    log.error('Git commit failed:', e.message);
  }
}

async function runTaskArchiver() {
  return taskStore.runExclusive(async () => {
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
        const result = await processProject(name);
        if (result) results.archived.push(result);
        else results.skipped.push(name);
      } catch (e: any) {
        results.errors.push(`${name}: ${e.message}`);
        log.error(`Error processing ${name}:`, e.message);
      }
    }

    if (results.archived.length > 0) await gitCommit(results.archived);

    const archivedCount = results.archived.reduce((sum, r) => sum + r.ids.length, 0);
    log.info(`Done. Archived ${archivedCount} tasks from ${results.archived.length} project(s)`);
    return results;
  });
}

export { runTaskArchiver };
