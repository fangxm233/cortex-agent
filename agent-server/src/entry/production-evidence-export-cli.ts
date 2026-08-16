// input:  launcher JSON and production CORTEX_HOME stores
// output: structured immutable evidence-export result
// pos:    Installed production evidence v2 export command
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';

import { formatError, formatHelp, readStdinSync } from '@core/cli-utils.js';
import { setProcessLogPolicy } from '@core/log.js';
import { isMainModule } from '@core/utils.js';
import { initializeProductionAttemptIdentity } from '@domain/agent-run/production-attempt-identity.js';
import {
  exportProductionBenchmarkEvidence,
  type ProductionEvidenceExportInput,
  type ProductionEvidenceExportResult,
} from '@domain/benchmark/production-evidence-export.js';
import { executionRepo } from '@store/execution-repo.js';
import { threadStore } from '@store/thread-repo.js';

interface ProductionEvidenceExportCliIo {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

export interface ProductionEvidenceExportCliDeps {
  readInput(source: string): string;
  prepareProductionStores(): void;
  exportEvidence(input: ProductionEvidenceExportInput): Promise<ProductionEvidenceExportResult>;
}

const DEFAULT_IO: ProductionEvidenceExportCliIo = {
  stdout: process.stdout,
  stderr: process.stderr,
};

function readInput(source: string): string {
  return source === '-' ? readStdinSync() : fs.readFileSync(path.resolve(source), 'utf8');
}

function prepareProductionStores(): void {
  initializeProductionAttemptIdentity();
  executionRepo.load();
  threadStore.load();
}

const DEFAULT_DEPS: ProductionEvidenceExportCliDeps = {
  readInput,
  prepareProductionStores,
  exportEvidence: input => exportProductionBenchmarkEvidence(input),
};

function parseArgs(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== '--input-file') {
    throw new Error(formatError(
      'Expected exactly --input-file <path|->.',
      { hint: "Run 'cortex-evidence-export --help' for usage." },
    ));
  }
  if (!args[1]) throw new Error('Missing value for --input-file.');
  return args[1];
}

function parseInput(text: string): ProductionEvidenceExportInput {
  try {
    return JSON.parse(text) as ProductionEvidenceExportInput;
  } catch (error) {
    throw new Error(`Input is not valid JSON: ${(error as Error).message}`);
  }
}

function success(result: ProductionEvidenceExportResult): string {
  return JSON.stringify({
    ok: true,
    directory: result.directory,
    composite_path: result.compositePath,
    composite_sha256: result.compositeSha256,
    terminal_paths: result.terminalPaths,
  });
}

function failure(error: unknown): string {
  return JSON.stringify({
    ok: false,
    error: (error as Error)?.message ?? String(error),
  });
}

export async function runProductionEvidenceExportCli(
  args: string[],
  io: ProductionEvidenceExportCliIo = DEFAULT_IO,
  deps: ProductionEvidenceExportCliDeps = DEFAULT_DEPS,
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    io.stdout.write(`${getProductionEvidenceExportHelp()}\n`);
    return 0;
  }
  const restoreLogPolicy = setProcessLogPolicy({
    consoleToStderr: true,
    files: false,
    console: false,
  });
  try {
    const input = parseInput(deps.readInput(parseArgs(args)));
    deps.prepareProductionStores();
    io.stdout.write(`${success(await deps.exportEvidence(input))}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${failure(error)}\n`);
    return 1;
  } finally {
    restoreLogPolicy();
  }
}

export function getProductionEvidenceExportHelp(): string {
  return formatHelp({
    name: 'cortex-evidence-export',
    description: 'Publish production terminal/composite benchmark evidence v2',
    usage: 'cortex-evidence-export --input-file <path|->',
    options: [
      { flag: '--input-file <path|->', description: 'ProductionEvidenceExportInput JSON, or - for stdin' },
      { flag: '--help, -h', description: 'Show this help' },
    ],
    examples: [
      { description: 'Read launcher input from a file', command: 'cortex-evidence-export --input-file production-evidence.json' },
      { description: 'Read launcher input from stdin', command: 'cat production-evidence.json | cortex-evidence-export --input-file -' },
    ],
  });
}

if (isMainModule(import.meta.url)) {
  runProductionEvidenceExportCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
