// input:  serialized C9 request, pinned runtime paths, benchmark orchestrator
// output: process-level result and initialized-store inventory
// pos:    Fresh-process fixture for benchmark thread orchestration
// >>> If I am updated, update my header and folder CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import {
  CONFIG_DIR, DATA_DIR, PROJECTS_DIR, STORE_DIR, WORKSPACE_DIR,
} from '../../../src/core/paths.js';
import { runBenchmarkThread } from '../../../src/domain/agent-run/benchmark-local-thread-orchestrator.js';
import { ctx as jobCtx } from '../../../src/domain/scheduling/job-registry.js';
import { threadStore } from '../../../src/store/thread-repo.js';

const requestFile = process.argv[2];
const outputFile = process.argv[3];
if (!requestFile || !outputFile) throw new Error('request and output paths are required');
function processSocketInodes(): Set<string> {
  const result = new Set<string>();
  for (const file of fs.readdirSync('/proc/self/fd')) {
    try {
      const match = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/self/fd/${file}`));
      if (match) result.add(match[1]);
    } catch {}
  }
  return result;
}

function listeningSocketInodes(): Set<string> {
  const result = new Set<string>();
  for (const name of ['tcp', 'tcp6']) {
    const rows = fs.readFileSync(`/proc/self/net/${name}`, 'utf8').trim().split('\n').slice(1);
    for (const row of rows) {
      const fields = row.trim().split(/\s+/);
      if (fields[3] === '0A') result.add(fields[9]);
    }
  }
  return result;
}

function hasListeningSocket(): boolean {
  const listening = listeningSocketInodes();
  return [...processSocketInodes()].some(inode => listening.has(inode));
}

function fakeInvocations(): Record<string, unknown>[] {
  const file = path.join(STORE_DIR, 'fake-run-agent.jsonl');
  return fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
const controller = new AbortController();
const result = await runBenchmarkThread({ ...request, signal: controller.signal });
const children = fs.readFileSync(`/proc/self/task/${process.pid}/children`, 'utf8').trim();
fs.writeFileSync(outputFile, `${JSON.stringify({
  result,
  argv: process.argv,
  paths: { CONFIG_DIR, DATA_DIR, PROJECTS_DIR, STORE_DIR, WORKSPACE_DIR },
  storeFiles: fs.readdirSync(STORE_DIR).sort(),
  invocations: fakeInvocations(),
  threadCount: threadStore.getAll().length,
  busIsNull: jobCtx.bus === null,
  listeningSocket: hasListeningSocket(),
  childPids: children ? children.split(/\s+/).map(Number) : [],
  cwd: process.cwd(),
})}\n`);
