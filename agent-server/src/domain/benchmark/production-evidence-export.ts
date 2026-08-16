// input:  launcher facts and durable production evidence stores
// output: atomically published terminal/composite v2 directory
// pos:    Public production benchmark evidence-export boundary
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  PRODUCTION_EVIDENCE_SOURCES,
  ProductionEvidenceExportError,
  assertProductionEvidenceExportInput,
  projectProductionBenchmarkEvidence,
  type ProductionEvidenceExportInput,
  type ProductionEvidenceProjection,
  type ProductionEvidenceSources,
} from './production-evidence-projection.js';

export type { ProductionEvidenceExportInput, ProductionEvidenceSources };
export { ProductionEvidenceExportError };

export interface ProductionEvidenceExportResult {
  readonly directory: string;
  readonly compositePath: string;
  readonly compositeSha256: string;
  readonly terminalPaths: readonly string[];
}

function fail(detail: string): never {
  throw new ProductionEvidenceExportError(detail);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function outputExists(outputPath: string): boolean {
  try { fs.lstatSync(outputPath); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function stagingPath(outputPath: string): string {
  const name = path.basename(outputPath);
  return path.join(path.dirname(outputPath), `.${name}.staging-${process.pid}-${randomUUID()}`);
}

function confinedPath(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative)) return fail(`invalid evidence path ${relative}`);
  const resolved = path.resolve(root, relative);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!resolved.startsWith(prefix)) return fail(`evidence path escapes output: ${relative}`);
  return resolved;
}

function durableWrite(filePath: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT
    | fs.constants.O_EXCL, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function writeProjection(staging: string, projection: ProductionEvidenceProjection): void {
  for (const [relative, bytes] of projection.files) {
    durableWrite(confinedPath(staging, relative), bytes);
  }
  const directories = new Set<string>([staging]);
  for (const relative of projection.files.keys()) {
    directories.add(path.dirname(confinedPath(staging, relative)));
  }
  [...directories].sort((left, right) => right.length - left.length).forEach(fsyncDirectory);
}

function verifyProjection(staging: string, projection: ProductionEvidenceProjection): void {
  for (const [relative, expected] of projection.files) {
    const observed = fs.readFileSync(confinedPath(staging, relative));
    if (sha256(observed) !== sha256(expected)) fail(`staged evidence changed: ${relative}`);
  }
}

function cleanupStaging(staging: string): void {
  if (outputExists(staging)) fs.rmSync(staging, { recursive: true });
}

function publishDirectory(staging: string, outputPath: string): void {
  const moved = spawnSync('mv', [
    '--no-clobber', '--no-target-directory', '--', staging, outputPath,
  ], { encoding: 'utf8' });
  if (moved.error) throw moved.error;
  if (moved.signal || moved.status !== 0) {
    fail(`atomic rename failed: ${moved.stderr.trim() || moved.signal || moved.status}`);
  }
  if (outputExists(staging)) fail(`output directory exists: ${outputPath}`);
  if (!outputExists(outputPath)) fail('atomic rename produced no output');
}

function result(
  outputPath: string, projection: ProductionEvidenceProjection,
): ProductionEvidenceExportResult {
  const compositePath = path.join(outputPath, 'composite-manifest.json');
  const bytes = projection.files.get('composite-manifest.json');
  if (!bytes) fail('composite projection is missing');
  return {
    directory: outputPath, compositePath, compositeSha256: sha256(bytes),
    terminalPaths: projection.terminalPaths.map(relative => path.join(outputPath, relative)),
  };
}

/**
 * Publishes one immutable evidence directory through a single same-filesystem rename. The hidden
 * payload is complete, fsynced and re-read before the public path exists; a prior publication is
 * never overwritten. Launcher and post-stop attestations remain separate P3/host-owned artifacts.
 */
export async function exportProductionBenchmarkEvidence(
  input: ProductionEvidenceExportInput,
  sources: ProductionEvidenceSources = PRODUCTION_EVIDENCE_SOURCES,
): Promise<ProductionEvidenceExportResult> {
  assertProductionEvidenceExportInput(input);
  const outputPath = path.resolve(input.outputDirectory);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  if (outputExists(outputPath)) fail(`output directory exists: ${outputPath}`);
  const projection = await projectProductionBenchmarkEvidence(input, sources);
  const staging = stagingPath(outputPath);
  try {
    fs.mkdirSync(staging, { mode: 0o700 });
    writeProjection(staging, projection);
    verifyProjection(staging, projection);
    publishDirectory(staging, outputPath);
    fsyncDirectory(path.dirname(outputPath));
    return result(outputPath, projection);
  } catch (error) {
    try { cleanupStaging(staging); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'evidence publication and cleanup failed');
    }
    throw error;
  }
}
