import { formatError, type CliResult } from '@core/cli-utils.js';
import { listMemoryProjects, regenProject } from '@domain/memory/index-regen.js';
import { analyzeProject, formatReport } from '@domain/memory/consolidate.js';
import { getMemoryHelp } from './cli-help.js';

// `cortex memory` runs the project-memory jobs on demand: index regeneration (the daemon also runs
// it on file changes and on a schedule) and the knowledge lifecycle report.

const COMMANDS = ['regen', 'consolidate'] as const;
type Command = typeof COMMANDS[number];

class UsageError extends Error {
  constructor(message: string, readonly validValues?: string[], readonly hint = 'cortex memory --help') {
    super(message);
  }
}

interface Parsed {
  projects: string[];
  text: boolean;
}

function parseArgs(command: Command, args: string[]): Parsed {
  const parsed: Parsed = { projects: [], text: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--project') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) throw new UsageError('Missing value for --project.');
      parsed.projects.push(value);
      i += 1;
    } else if (arg === '--text' && command === 'consolidate') {
      parsed.text = true;
    } else {
      const valid = command === 'consolidate' ? ['--project', '--text'] : ['--project'];
      throw new UsageError(`Unknown argument for '${command}': '${arg}'.`, valid);
    }
  }
  return parsed;
}

/** The requested projects, or every project with memory directories when none is named. */
function resolveProjects(requested: string[]): string[] {
  const known = listMemoryProjects();
  if (requested.length === 0) return known;
  const unknown = requested.filter((p) => !known.includes(p));
  if (unknown.length > 0) {
    throw new UsageError(`Unknown project: '${unknown[0]}' (no experiments/, knowledge/ or patterns/ directory).`, known);
  }
  return requested;
}

function runRegen(parsed: Parsed): string {
  const projects = resolveProjects(parsed.projects).map((project) => ({ project, indexes: regenProject(project) }));
  return JSON.stringify({ ok: true, projects }, null, 2);
}

function runConsolidate(parsed: Parsed): string {
  const reports = resolveProjects(parsed.projects).map((project) => analyzeProject(project));
  return parsed.text ? formatReport(reports) : JSON.stringify({ ok: true, reports }, null, 2);
}

function fail(message: string, validValues?: string[], hint?: string): CliResult {
  return { exitCode: 1, stdout: '', stderr: formatError(message, { validValues, hint }) };
}

/** `cortex memory <regen|consolidate>` — rebuild memory indexes / report knowledge lifecycle. */
export function runMemoryCli(args: string[]): CliResult {
  if (args.includes('--help') || args.includes('-h')) return { exitCode: 0, stdout: getMemoryHelp(), stderr: '' };
  const [command, ...rest] = args;
  if (!command) return fail("Missing subcommand for 'memory'.", [...COMMANDS]);
  if (!(COMMANDS as readonly string[]).includes(command)) return fail(`Unknown subcommand: '${command}'.`, [...COMMANDS]);
  try {
    const parsed = parseArgs(command as Command, rest);
    const stdout = command === 'regen' ? runRegen(parsed) : runConsolidate(parsed);
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error) {
    if (error instanceof UsageError) return fail(error.message, error.validValues, error.hint);
    return fail((error as Error).message);
  }
}
