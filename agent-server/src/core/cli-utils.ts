// input:  help spec objects, optional labels, error context, stdin
// output: localized help/error formatting and stdin readers
// pos:    Shared CLI presentation and stdin utilities
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as fs from 'node:fs';

// ─── Help Rendering (Rule ②) ───────────────────────────────────

interface CommandSpec {
  name: string;
  description: string;
}

interface OptionSpec {
  flag: string;
  description: string;
  default?: string;
}

interface ExampleSpec {
  description: string;
  command: string;
}

interface HelpLabels {
  usage: string;
  commands: string;
  options: string;
  examples: string;
}

interface HelpSpec {
  name: string;
  description: string;
  usage: string;
  commandGroups?: { heading: string; commands: CommandSpec[] }[];
  commands?: CommandSpec[];
  options?: OptionSpec[];
  examples?: ExampleSpec[];
  labels?: Partial<HelpLabels>;
}

function appendCommands(lines: string[], spec: HelpSpec, label: string): void {
  if (spec.commandGroups && spec.commandGroups.length > 0) {
    lines.push('', label);
    for (const group of spec.commandGroups) {
      lines.push(`  ${group.heading}:`);
      for (const cmd of group.commands) lines.push(`    ${cmd.name.padEnd(22)} ${cmd.description}`);
    }
    return;
  }
  if (!spec.commands || spec.commands.length === 0) return;
  lines.push('', label);
  for (const cmd of spec.commands) lines.push(`  ${cmd.name.padEnd(22)} ${cmd.description}`);
}

function appendOptions(lines: string[], options: OptionSpec[] | undefined, label: string): void {
  if (!options || options.length === 0) return;
  lines.push('', label);
  for (const option of options) {
    const defaultText = option.default != null ? `  (default: ${option.default})` : '';
    lines.push(`  ${option.flag.padEnd(28)} ${option.description}${defaultText}`);
  }
}

function appendExamples(lines: string[], examples: ExampleSpec[] | undefined, label: string): void {
  if (!examples || examples.length === 0) return;
  lines.push('', label);
  for (const example of examples) {
    lines.push(`  # ${example.description}`, `  ${example.command}`, '');
  }
}

function formatHelp(spec: HelpSpec): string {
  const labels: HelpLabels = {
    usage: 'Usage:', commands: 'Commands:', options: 'Options:', examples: 'Examples:',
    ...spec.labels,
  };
  const lines = [spec.description, '', `${labels.usage} ${spec.usage}`];
  appendCommands(lines, spec, labels.commands);
  appendOptions(lines, spec.options, labels.options);
  appendExamples(lines, spec.examples, labels.examples);
  return lines.join('\n').trimEnd();
}

// ─── Error Formatting (Rule ④) ─────────────────────────────────

interface ErrorLabels {
  validValues: string;
  hint: string;
}

function formatError(
  message: string,
  opts?: { validValues?: string[]; hint?: string; labels?: Partial<ErrorLabels> },
): string {
  const labels: ErrorLabels = { validValues: 'Valid values:', hint: 'Hint:', ...opts?.labels };
  let result = message;
  if (opts?.validValues && opts.validValues.length > 0) {
    result += `\n${labels.validValues} ${opts.validValues.join(', ')}`;
  }
  if (opts?.hint) result += `\n${labels.hint} ${opts.hint}`;
  return result;
}

// ─── Stdin Reading (Rule ③) ────────────────────────────────────

function readStdinBufferSync(): Buffer {
  return fs.readFileSync(0);
}

function readStdinSync(): string {
  return readStdinBufferSync().toString('utf8');
}

// ─── CLI Error Helper ─────────────────────────────────────────

/** Create an Error with a cliMessage property for structured CLI error handling */
function cliError(message: string): Error & { cliMessage?: string } {
  const error = new Error(message) as Error & { cliMessage?: string };
  error.cliMessage = message;
  return error;
}

export {
  formatHelp,
  formatError,
  readStdinSync,
  readStdinBufferSync,
  cliError,
};
export type { HelpSpec, HelpLabels, CommandSpec, OptionSpec, ExampleSpec };
