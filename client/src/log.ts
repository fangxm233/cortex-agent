// Client-side logger — console output + optional daily-rotating file sink.
// Simplified copy of agent-server/src/core/log.ts.
import fs from 'node:fs';
import path from 'node:path';
import { LOGS_DIR } from './paths.js';

const RETENTION_DAYS = 14;

type Level = 'INFO' | 'WARN' | 'ERROR';

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

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
    try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch { /* best effort */ }
    currentDate = tag;
    stream = fs.createWriteStream(
      path.join(LOGS_DIR, `client-${tag}.log`),
      { flags: 'a' },
    );
    if (lastCleanup !== tag) {
      lastCleanup = tag;
      cleanOldLogs();
    }
  }
  return stream;
}

function cleanOldLogs(): void {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    for (const f of fs.readdirSync(LOGS_DIR)) {
      const m = f.match(/^client-(\d{4})(\d{2})(\d{2})\.log$/);
      if (!m) continue;
      const fileDate = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
      if (fileDate < cutoff) {
        fs.unlinkSync(path.join(LOGS_DIR, f));
      }
    }
  } catch {
    // best-effort cleanup
  }
}

function formatArg(a: unknown): string {
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === 'object' && a !== null) {
    try { return JSON.stringify(a); } catch { return String(a); }
  }
  return String(a);
}

function write(level: Level, mod: string, args: unknown[]): void {
  const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const prefix = `[${mod} ${ts}]`;

  switch (level) {
    case 'ERROR': console.error(prefix, ...args); break;
    case 'WARN':  console.warn(prefix, ...args);  break;
    default:      console.log(prefix, ...args);
  }

  const line = `${prefix} ${level} ${args.map(formatArg).join(' ')}\n`;
  try { getStream().write(line); } catch { /* don't crash on write failure */ }
}

export function createLogger(mod: string): Logger {
  return {
    info:  (...args) => write('INFO', mod, args),
    warn:  (...args) => write('WARN', mod, args),
    error: (...args) => write('ERROR', mod, args),
  };
}

process.on('exit', () => { stream?.end(); });
