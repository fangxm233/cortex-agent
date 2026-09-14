import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { createLogger } from '@core/log.js';

const log = createLogger('event-replay');

const { values } = parseArgs({
  options: {
    date: { type: 'string' },
    type: { type: 'string' },
  },
  strict: false,
});

const rawDate = typeof values.date === 'string' ? values.date : undefined;
const dateStr = rawDate ?? new Date().toISOString().slice(0, 10).replace(/-/g, '');
// Normalise: allow YYYY-MM-DD input and convert to YYYYMMDD
const normalizedDate = dateStr.replace(/-/g, '');

const typeFilter = typeof values.type === 'string' ? values.type : undefined;

// Resolve log dir relative to this file: src/events/ → ../../logs/events
const logDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'logs', 'events');
const logFile = path.join(logDir, `events-${normalizedDate}.jsonl`);

if (!existsSync(logFile)) {
  log.error(`No log file found: ${logFile}`);
  process.exit(1);
}

const rl = createInterface({
  input: createReadStream(logFile, { encoding: 'utf8' }),
  crlfDelay: Infinity,
});

rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const entry = JSON.parse(line);
    if (typeFilter && entry.type !== typeFilter) return;
    console.log(line);
  } catch {
    // Skip malformed lines
  }
});

rl.on('error', (err) => {
  log.error('Error reading log file:', err.message);
  process.exit(1);
});
