// input:  JSON task specs, filesystem, and stdin reader
// output: Normalized TaskFileSpec values
// pos:    Parses shell-free add and spawn task input
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as fs from 'node:fs';
import { cliError, readStdinSync } from '@core/cli-utils.js';

export interface TaskFileSpec {
  text: string;
  why: string | null;
  doneWhen: string | null;
  plan: string | null;
  priority: string | null;
  template: string | null;
  dependsOn: string[];
}

type TaskSpecRecord = Record<string, unknown>;

function parseTaskSpecJson(content: string): TaskSpecRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw cliError(`Invalid task file JSON: ${detail}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw cliError('Task file must contain a single JSON object');
  }
  return parsed as TaskSpecRecord;
}

function optionalString(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw cliError(`Task file field '${field}' must be a string`);
  return value;
}

function requiredText(record: TaskSpecRecord): string {
  const text = optionalString(record.text, 'text');
  if (!text) throw cliError("Task file field 'text' is required");
  return text;
}

function dependsOn(record: TaskSpecRecord): string[] {
  const value = record['depends-on'] ?? record.depends_on ?? record.dependsOn;
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw cliError("Task file field 'depends-on' must be an array of strings");
  }
  return value as string[];
}

function normalizeTaskSpec(record: TaskSpecRecord): TaskFileSpec {
  return {
    text: requiredText(record),
    why: optionalString(record.why, 'why'),
    doneWhen: optionalString(record['done-when'] ?? record.done_when ?? record.doneWhen, 'done-when'),
    plan: optionalString(record.plan, 'plan'),
    priority: optionalString(record.priority, 'priority'),
    template: optionalString(record.template, 'template'),
    dependsOn: dependsOn(record),
  };
}

export function readTaskSpec(
  source: string,
  readStdin: () => string = readStdinSync,
): TaskFileSpec {
  const content = source === '-' ? readStdin() : fs.readFileSync(source, 'utf8');
  return normalizeTaskSpec(parseTaskSpecJson(content));
}
