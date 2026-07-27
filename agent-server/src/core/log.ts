// input:  shared process-wide DEBUG gate
// output: createLogger() factory
// pos:    centralized logging — console + daily-rotating file sink, DEBUG-gated debug level
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import { LOGS_DIR } from './paths.js';
import { isDebugMode } from './debug-mode.js';

// Prevent EPIPE/SIGPIPE from killing the process when stderr/stdout is a broken
// pipe (e.g. terminal closed, journald restart, parent process exited).
// Without these listeners, Node throws EPIPE on write → if that write happens
// inside an uncaughtException handler, it causes a re-entrant crash loop that
// fills the log file and the disk.
process.stderr.on('error', () => {});
process.stdout.on('error', () => {});

// ── Config ──────────────────────────────────────────────
const RETENTION_DAYS = 14;
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB — rotate when exceeded
const MAX_ROTATED_FILES = 2;            // keep up to .1.log, .2.log

type Level = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

// ── File sink (daily rotation) ──────────────────────────
let currentDate = '';
let stream: fs.WriteStream | null = null;
let lastCleanup = '';

function dateTag(): string {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('');
}

function getStream(): fs.WriteStream {
  const tag = dateTag();
  if (tag !== currentDate || !stream) {
    stream?.end();
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    currentDate = tag;
    stream = fs.createWriteStream(
      path.join(LOGS_DIR, `server-${tag}.log`),
      { flags: 'a' },
    );
    // attempt cleanup at most once per calendar day
    if (lastCleanup !== tag) {
      lastCleanup = tag;
      cleanOldLogs();
    }
  }

  // Size-based rotation: if current file exceeds MAX_FILE_SIZE,
  // rotate it and open a fresh one (same date tag).
  if (stream.bytesWritten >= MAX_FILE_SIZE) {
    stream.end();
    stream = rotateLogFile(tag);
  }

  return stream;
}

/** Rotate the current day's log file: server-YYYYMMDD.log → .1.log → .2.log.
 *  Opens a fresh server-YYYYMMDD.log and returns the new stream. */
function rotateLogFile(tag: string): fs.WriteStream {
  const base = path.join(LOGS_DIR, `server-${tag}`);
  // Shift existing rotations: .1.log → .2.log (drop older if any)
  for (let i = MAX_ROTATED_FILES; i >= 1; i--) {
    const oldPath = `${base}.${i}.log`;
    const newPath = `${base}.${i + 1}.log`;
    try {
      if (i === MAX_ROTATED_FILES) {
        try { fs.unlinkSync(newPath); } catch { /* doesn't exist */ }
      }
      fs.renameSync(oldPath, newPath);
    } catch { /* file may not exist */ }
  }
  // Rotate current to .1.log
  try { fs.renameSync(`${base}.log`, `${base}.1.log`); } catch { /* ignore */ }
  // Open fresh log
  return fs.createWriteStream(`${base}.log`, { flags: 'a' });
}

function cleanOldLogs(): void {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    for (const f of fs.readdirSync(LOGS_DIR)) {
      const m = f.match(/^server-(\d{4})(\d{2})(\d{2})\.log$/);
      if (!m) continue;
      const fileDate = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
      if (fileDate < cutoff) {
        fs.unlinkSync(path.join(LOGS_DIR, f));
      }
    }
  } catch {
    // best-effort cleanup — don't crash on permission errors etc.
  }
}

// ── Formatting ──────────────────────────────────────────
function formatArg(a: unknown): string {
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === 'object' && a !== null) {
    try { return JSON.stringify(a); } catch { return String(a); }
  }
  return String(a);
}

// ── Core write ──────────────────────────────────────────
function write(level: Level, mod: string, args: unknown[]): void {
  const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const prefix = `[${mod} ${ts}]`;

  // Console output — wrapped so a broken pipe (EPIPE) on stderr/stdout doesn't
  // crash the process. See also the stderr/stdout error listeners at the top of
  // this file.
  try {
    switch (level) {
      case 'ERROR': console.error(prefix, ...args); break;
      case 'WARN':  console.warn(prefix, ...args);  break;
      case 'DEBUG': console.debug(prefix, ...args);  break;
      default:      console.log(prefix, ...args);
    }
  } catch {
    // stderr/stdout may be a broken pipe — ignore; file sink below still works
  }

  // File output
  const line = `${prefix} ${level} ${args.map(formatArg).join(' ')}\n`;
  try { getStream().write(line); } catch { /* don't crash on write failure */ }
}

// ── Factory ─────────────────────────────────────────────
export function createLogger(mod: string): Logger {
  return {
    info:  (...args) => write('INFO', mod, args),
    warn:  (...args) => write('WARN', mod, args),
    error: (...args) => write('ERROR', mod, args),
    debug: (...args) => { if (isDebugMode()) write('DEBUG', mod, args); },
  };
}

// Flush on process exit
process.on('exit', () => { stream?.end(); });
