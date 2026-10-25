import { readFileSync } from 'node:fs';
import path from 'node:path';
import { INSTALL_ROOT } from '@core/paths.js';

/** Release CI writes this next to the compiled server; source builds have none. */
export const BUILD_INFO_FILE = path.join(INSTALL_ROOT, 'dist', 'build-info.json');

let cachedBuildEndpoint: string | null | undefined;

function validEndpoint(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function readBuildEndpoint(file: string): string | null {
  try {
    const info = JSON.parse(readFileSync(file, 'utf8')) as { telemetryEndpoint?: unknown };
    return validEndpoint(info.telemetryEndpoint);
  } catch {
    return null;
  }
}

/**
 * Where batches go: `CORTEX_TELEMETRY_ENDPOINT` (tests, self-hosted sinks), else the endpoint
 * the release build recorded. Null means nothing is ever sent.
 */
export function resolveTelemetryEndpoint(
  env: NodeJS.ProcessEnv = process.env,
  buildInfoFile: string = BUILD_INFO_FILE,
): string | null {
  const override = validEndpoint(env.CORTEX_TELEMETRY_ENDPOINT);
  if (override) return override;
  if (buildInfoFile !== BUILD_INFO_FILE) return readBuildEndpoint(buildInfoFile);
  if (cachedBuildEndpoint === undefined) cachedBuildEndpoint = readBuildEndpoint(buildInfoFile);
  return cachedBuildEndpoint;
}
