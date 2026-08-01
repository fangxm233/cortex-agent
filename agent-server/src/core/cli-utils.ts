// input:  help spec objects, error context, stdin fd
// output: help/error formatting and text/raw-byte stdin readers
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

interface HelpSpec {
  name: string;
  description: string;
  usage: string;
  commandGroups?: { heading: string; commands: CommandSpec[] }[];
  commands?: CommandSpec[];
  options?: OptionSpec[];
  examples?: ExampleSpec[];
}

function formatHelp(spec: HelpSpec): string {
  const lines: string[] = [];

  lines.push(spec.description);
  lines.push('');
  lines.push(`Usage: ${spec.usage}`);

  if (spec.commandGroups && spec.commandGroups.length > 0) {
    lines.push('');
    lines.push('Commands:');
    for (const group of spec.commandGroups) {
      lines.push(`  ${group.heading}:`);
      for (const cmd of group.commands) {
        lines.push(`    ${cmd.name.padEnd(22)} ${cmd.description}`);
      }
    }
  } else if (spec.commands && spec.commands.length > 0) {
    lines.push('');
    lines.push('Commands:');
    for (const cmd of spec.commands) {
      lines.push(`  ${cmd.name.padEnd(22)} ${cmd.description}`);
    }
  }

  if (spec.options && spec.options.length > 0) {
    lines.push('');
    lines.push('Options:');
    for (const opt of spec.options) {
      const defaultText = opt.default != null ? `  (default: ${opt.default})` : '';
      lines.push(`  ${opt.flag.padEnd(28)} ${opt.description}${defaultText}`);
    }
  }

  if (spec.examples && spec.examples.length > 0) {
    lines.push('');
    lines.push('Examples:');
    for (const ex of spec.examples) {
      lines.push(`  # ${ex.description}`);
      lines.push(`  ${ex.command}`);
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd();
}

// ─── Error Formatting (Rule ④) ─────────────────────────────────

function formatError(message: string, opts?: { validValues?: string[]; hint?: string }): string {
  let result = message;
  if (opts?.validValues && opts.validValues.length > 0) {
    result += `\nValid values: ${opts.validValues.join(', ')}`;
  }
  if (opts?.hint) {
    result += `\nHint: ${opts.hint}`;
  }
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
export type { HelpSpec, CommandSpec, OptionSpec, ExampleSpec };
