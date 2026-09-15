#!/usr/bin/env node
// input:  a store-dir argument (e.g. ~/.cortex/tmp/b/g1-run1/data) holding legacy sessions.json +
//         conversation-ledger.json + session-registry.jsonl + versions.json
// output: a human-readable dry-run of importLegacySessionStores — BEFORE file stats, the import
//         summary, AFTER journal/rename stats, a READ-BACK verification against a fresh repo, and the
//         versions.json diff (mirroring what runMigrations' step loop writes on success). Then a
//         second run to show idempotency.
// pos:    Dev tool (agent-server/scripts). Touches ONLY the store dir passed in; never the live
//         daemon or its stores. Run from agent-server/ so tsx resolves the @-path aliases:
//           node --import tsx scripts/dry-run-session-import.ts <store-dir>
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { importLegacySessionStores } from '@store/session-registry-import.js';
import { SessionRegistryRepo } from '@store/session-registry-repo.js';
import { loadVersionsFrom, saveVersionsTo } from '@store/version-migrations.js';

const VERSION = '2026.9.14';
const STEP_KEY = 'data/session-registry.jsonl';
const SESSIONS = 'sessions.json';
const LEDGER = 'conversation-ledger.json';
const JOURNAL = 'session-registry.jsonl';
const VERSIONS = 'versions.json';

async function fileStat(filePath: string): Promise<{ exists: boolean; size: number; lines: number }> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return { exists: true, size: raw.length, lines: raw.split('\n').filter((l) => l.length > 0).length };
  } catch {
    return { exists: false, size: 0, lines: 0 };
  }
}

async function readJsonOr<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function line(label: string, s: { exists: boolean; size: number; lines: number }): string {
  return `  ${label.padEnd(26)} exists=${s.exists} size=${s.size} lines=${s.lines}`;
}

async function report(storeDir: string, tag: string): Promise<void> {
  console.log(`\n=== ${tag} FILE STATE (${storeDir}) ===`);
  for (const f of [SESSIONS, LEDGER, JOURNAL]) {
    console.log(line(f, await fileStat(path.join(storeDir, f))));
  }
  for (const f of [`${SESSIONS}.pre-${VERSION}.bak`, `${LEDGER}.pre-${VERSION}.bak`]) {
    const s = await fileStat(path.join(storeDir, f));
    if (s.exists) console.log(line(f, s));
  }
}

async function readBack(storeDir: string, sessions: Record<string, string>, ledger: Record<string, any>): Promise<void> {
  console.log(`\n=== READ-BACK (fresh repo replays ${JOURNAL} from disk) ===`);
  const repo = new SessionRegistryRepo(path.join(storeDir, JOURNAL));

  let bindingsOk = 0;
  let bindingsBad = 0;
  for (const [channel, sessionId] of Object.entries(sessions)) {
    const got = await repo.getBoundSessionId(channel);
    if (got === sessionId) bindingsOk += 1;
    else { bindingsBad += 1; console.log(`  MISMATCH binding ${channel}: expected ${sessionId} got ${got}`); }
  }
  console.log(`  bindings resolved: ${bindingsOk}/${Object.keys(sessions).length} (mismatches=${bindingsBad})`);

  let headerCount = 0;
  let profileNames = 0;
  let turnTotal = 0;
  let turnsOk = 0;
  let turnsBad = 0;
  for (const [channel, header] of Object.entries(ledger)) {
    const conv = await repo.readConversation(channel);
    if (!conv) { turnsBad += 1; console.log(`  MISSING conversation ${channel}`); continue; }
    headerCount += 1;
    if (conv.header.profileName) profileNames += 1;
    const expected = Array.isArray(header.turns) ? header.turns.length : 0;
    const got = (await repo.getTurns(channel)).length;
    turnTotal += got;
    if (got === expected) turnsOk += 1;
    else { turnsBad += 1; console.log(`  TURN COUNT ${channel}: expected ${expected} got ${got}`); }
  }
  console.log(`  conversation headers: ${headerCount}/${Object.keys(ledger).length}`);
  console.log(`  per-channel turn counts matched: ${turnsOk} (mismatches=${turnsBad})`);
  console.log(`  total turns read back: ${turnTotal}`);
  console.log(`  profileName headers: ${profileNames}`);
}

function versionsDiff(before: Record<string, string>, after: Record<string, string>): void {
  console.log('\n=== versions.json DIFF ===');
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  let any = false;
  for (const k of keys) {
    if (before[k] !== after[k]) { console.log(`  ${k}: ${before[k] ?? '(absent)'} -> ${after[k] ?? '(absent)'}`); any = true; }
  }
  if (!any) console.log('  (no change)');
}

async function main(): Promise<void> {
  const storeDir = process.argv[2];
  if (!storeDir) {
    console.error('usage: node --import tsx scripts/dry-run-session-import.ts <store-dir>');
    process.exit(2);
  }
  console.log(`### dry-run-session-import @ ${new Date().toISOString()} — version ${VERSION}`);

  // Snapshot the sources BEFORE the import renames them, for read-back verification.
  const sessions = await readJsonOr<Record<string, string>>(path.join(storeDir, SESSIONS), {});
  const ledger = await readJsonOr<Record<string, any>>(path.join(storeDir, LEDGER), {});
  const versionsBefore = await loadVersionsFrom(path.join(storeDir, VERSIONS));

  await report(storeDir, 'BEFORE');

  const summary = await importLegacySessionStores(storeDir, { version: VERSION });
  console.log('\n=== IMPORT SUMMARY ===');
  console.log(`  bindings=${summary.bindings} conversations=${summary.conversations} turns=${summary.turns} `
    + `profileNames=${summary.profileNames}`);
  console.log(`  skipped=${JSON.stringify(summary.skipped)} renamed=${JSON.stringify(summary.renamed)}`);

  // Mirror what runMigrations' step loop writes on success (import itself does not touch versions.json).
  const versionsAfter = { ...(await loadVersionsFrom(path.join(storeDir, VERSIONS))) };
  versionsAfter[STEP_KEY] = VERSION;
  await saveVersionsTo(path.join(storeDir, VERSIONS), versionsAfter);

  await report(storeDir, 'AFTER');
  await readBack(storeDir, sessions, ledger);
  versionsDiff(versionsBefore, versionsAfter);

  // Second run on the same dir — sources are renamed away → a no-op.
  const linesBefore = (await fileStat(path.join(storeDir, JOURNAL))).lines;
  const second = await importLegacySessionStores(storeDir, { version: VERSION });
  const linesAfter = (await fileStat(path.join(storeDir, JOURNAL))).lines;
  console.log('\n=== SECOND RUN (idempotency) ===');
  console.log(`  summary: bindings=${second.bindings} conversations=${second.conversations} turns=${second.turns} `
    + `profileNames=${second.profileNames} skipped=${JSON.stringify(second.skipped)} renamed=${JSON.stringify(second.renamed)}`);
  console.log(`  journal lines: ${linesBefore} -> ${linesAfter} (${linesBefore === linesAfter ? 'UNCHANGED — no-op' : 'CHANGED — NOT idempotent!'})`);
}

main().catch((err) => { console.error(err); process.exit(1); });
