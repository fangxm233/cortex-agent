#!/usr/bin/env node
// @cortex-hook-version 2026.6.22-2

import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, resolve } from 'path';
import { homedir } from 'os';

const DATA_DIR = process.env.CORTEX_HOME
  ? resolve(process.env.CORTEX_HOME)
  : join(homedir(), '.cortex');
const PROJECTS_DIR = process.env.CORTEX_PROJECTS_DIR
  ? resolve(process.env.CORTEX_PROJECTS_DIR)
  : join(DATA_DIR, 'context', 'projects');

const MEMORY_FILE_RE = /\/(experiments|knowledge|patterns)\/(EXP-\d+[a-z]?|K-\d+|PAT-\d+)\.md$/;
const PROJECT_PATH_RE = /\/context\/projects\/([^/]+)\//;

function extractProjectName(filePath) {
  const m = filePath.match(PROJECT_PATH_RE);
  return m ? m[1] : null;
}

function extractMemoryFiles(filePath) {
  const m = filePath.match(MEMORY_FILE_RE);
  if (!m) return null;
  return `${m[2]}.md`;
}

function appendAccessLog(project, filename, toolName) {
  const metaDir = join(PROJECTS_DIR, project, '_meta');
  if (!existsSync(metaDir)) {
    mkdirSync(metaDir, { recursive: true });
  }

  const logPath = join(metaDir, 'access-log.jsonl');
  const record = {
    file: filename,
    tool: toolName,
    ts: new Date().toISOString(),
  };

  appendFileSync(logPath, JSON.stringify(record) + '\n');
}

function processReadTool(payload) {
  const filePath = payload.tool_input?.file_path;
  if (!filePath) return;

  const filename = extractMemoryFiles(filePath);
  if (!filename) return;

  const project = extractProjectName(filePath);
  if (!project) return;

  appendAccessLog(project, filename, 'Read');
}

function processGrepTool(payload) {
  const searchPath = payload.tool_input?.path;
  if (!searchPath) return;

  const projectMatch = searchPath.match(PROJECT_PATH_RE);
  if (!projectMatch) return;

  const project = projectMatch[1];

  if (!/\/(experiments|knowledge|patterns)(\/|$)/.test(searchPath)) return;

  const output = payload.tool_output || '';
  const seen = new Set();

  const fileMatches = output.matchAll(/(?:^|\n)\s*([^\n]*\/(EXP-\d+[a-z]?|K-\d+|PAT-\d+)\.md)/g);
  for (const match of fileMatches) {
    const filename = `${match[2]}.md`;
    if (!seen.has(filename)) {
      seen.add(filename);
      appendAccessLog(project, filename, 'Grep');
    }
  }

  if (seen.size === 0) {
    appendAccessLog(project, '_directory_search', 'Grep');
  }
}

function autoCommitAccessLog() {
  try {
    let hasStaged = false;
    try {
      execSync('git diff --cached --quiet', { cwd: DATA_DIR, timeout: 5_000 });
    } catch {
      hasStaged = true;
    }

    let dirty;
    try {
      dirty = execSync(
        "git diff --name-only -- '**/access-log.jsonl'",
        { cwd: DATA_DIR, encoding: 'utf8', timeout: 5_000 },
      ).trim();
    } catch {
      return;
    }
    if (!dirty) return;

    const files = dirty.split('\n').filter(Boolean);
    for (const f of files) {
      execSync(`git add -- ${JSON.stringify(f)}`, { cwd: DATA_DIR, timeout: 5_000 });
    }

    if (!hasStaged) {
      execSync('git commit -m "chore: update access log" --no-gpg-sign', {
        cwd: DATA_DIR, timeout: 10_000, stdio: 'pipe',
      });
    }
  } catch {
    // Silently ignore — committing is best-effort
  }
}

function main() {
  let input = '';

  try {
    input = readFileSync(0, 'utf8');
  } catch {
    return;
  }

  if (!input.trim()) return;

  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return;
  }

  const toolName = payload.tool_name;
  if (!toolName) return;

  if (toolName === 'Read') {
    processReadTool(payload);
  } else if (toolName === 'Grep') {
    processGrepTool(payload);
  }

  autoCommitAccessLog();
}

main();
