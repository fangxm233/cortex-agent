// input:  merge flags and filesystem adapter
// output: help or structured merge result
// pos:    Standalone CLI for tree-aware trajectory publication
// >>> If I am updated, update my header and folder CORTEX.md <<<

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatError, formatHelp } from '../../core/cli-utils.js';
import {
  mergeTrajectory,
  NODE_TRAJECTORY_MERGE_FS,
  TrajectoryMergeError,
  type TrajectoryMergeFileSystem,
} from './trajectory-merge.js';
import type { ThreadLink } from './atif.js';

interface Writable {
  write(value: string): unknown;
}

export interface TrajectoryMergeCliIo {
  stdout: Writable;
  stderr: Writable;
}

interface CliOptions {
  trajectoryRoot: string;
  outputPath: string;
  subagentLinks: ThreadLink[];
}

interface ParsedValues {
  values: Map<string, string>;
  subagentLinks: string[];
}

const FLAGS = new Set(['--trajectory-root', '--output', '--subagent-link']);

function invalid(message: string, hint?: string): never {
  throw Object.assign(new Error(formatError(message, {
    validValues: [...FLAGS], hint,
  })), { reason: 'invalid_arguments' });
}

function storeFlag(parsed: ParsedValues, flag: string, value: string): void {
  if (flag === '--subagent-link') {
    parsed.subagentLinks.push(value);
    return;
  }
  if (parsed.values.has(flag)) invalid(`Duplicate option: '${flag}'`);
  parsed.values.set(flag, value);
}

function parsePairs(args: string[]): ParsedValues {
  if (args.length % 2 !== 0) invalid(`Missing value for ${args.at(-1)}`);
  const parsed: ParsedValues = { values: new Map(), subagentLinks: [] };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!FLAGS.has(flag)) invalid(`Unknown option: '${flag}'`);
    storeFlag(parsed, flag, args[index + 1]);
  }
  return parsed;
}

function required(values: Map<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value) return value;
  return invalid(`Missing required ${flag}`, 'Run with --help for usage.');
}

function parseLink(value: string): ThreadLink {
  const separator = value.indexOf('=');
  if (separator <= 0 || separator === value.length - 1) {
    return invalid(`Invalid --subagent-link: '${value}'`, 'Use <tool_use_id>=<thread_id>.');
  }
  return { callId: value.slice(0, separator), threadId: value.slice(separator + 1) };
}

function parseArgs(args: string[]): CliOptions {
  const parsed = parsePairs(args);
  return {
    trajectoryRoot: path.resolve(required(parsed.values, '--trajectory-root')),
    outputPath: path.resolve(required(parsed.values, '--output')),
    subagentLinks: parsed.subagentLinks.map(parseLink),
  };
}

function failurePayload(error: unknown): Record<string, unknown> {
  const reason = error instanceof TrajectoryMergeError
    ? error.reason : (error as { reason?: string })?.reason ?? 'malformed_fragment';
  return {
    ok: false,
    reason,
    message: error instanceof Error ? error.message : String(error),
  };
}

export function getTrajectoryMergeHelp(): string {
  return formatHelp({
    name: 'cortex trajectory-merge',
    description: 'Merge validated parent and child journals into one ATIF-v1.7 trajectory',
    usage: 'node dist/domain/agent-run/trajectory-merge-cli.js --trajectory-root <dir> --output <file>',
    options: [
      { flag: '--trajectory-root <dir>', description: 'Directory containing C2/C3 lifecycle files' },
      { flag: '--output <file>', description: 'Fresh ATIF path in a writable directory; never overwritten' },
      { flag: '--subagent-link <tool=id>', description: 'Repeatable tool_use_id=thread_id override', default: 'tool result JSON' },
      { flag: '--help, -h', description: 'Show this help' },
    ],
    examples: [{
      description: 'Merge one trial artifact tree',
      command: 'node dist/domain/agent-run/trajectory-merge-cli.js --trajectory-root ./artifacts --output ./artifacts/trajectory.json',
    }],
  });
}

export function runTrajectoryMergeCli(
  args: string[],
  io: TrajectoryMergeCliIo = { stdout: process.stdout, stderr: process.stderr },
  fileSystem: TrajectoryMergeFileSystem = NODE_TRAJECTORY_MERGE_FS,
): number {
  if (args.includes('--help') || args.includes('-h')) {
    io.stdout.write(`${getTrajectoryMergeHelp()}\n`);
    return 0;
  }
  try {
    const options = parseArgs(args);
    const result = mergeTrajectory({
      trajectoryRoot: options.trajectoryRoot,
      outputPath: options.outputPath,
      subagentLinks: options.subagentLinks,
    }, fileSystem);
    io.stdout.write(`${JSON.stringify({
      ok: true,
      output_path: result.outputPath,
      sha256: result.sha256,
      trajectory_id: result.trajectoryId,
      fragments: result.fragments,
    })}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${JSON.stringify(failurePayload(error))}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) process.exitCode = runTrajectoryMergeCli(process.argv.slice(2));
