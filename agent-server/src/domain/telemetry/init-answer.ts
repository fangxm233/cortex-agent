import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { adoptInstallId, isInstallId } from './install-id.js';
import { InitTelemetryAnswerSchema, type InitTelemetryAnswer } from './schema.js';

/** The `telemetry` field of `cortex init --answers`, or undefined when absent or malformed. */
export function parseInitTelemetryAnswer(value: unknown): InitTelemetryAnswer | undefined {
  if (value === undefined) return undefined;
  const parsed = InitTelemetryAnswerSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function readSettingsObject(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Persist the init choice into the new home: `telemetryEnabled` in settings.json, and the
 * caller's install id (the desktop shell's, so its setup events and the server's join up) unless
 * this home already has one.
 */
export function applyInitTelemetry(
  answer: InitTelemetryAnswer, dirs: { configDir: string; storeDir: string },
): void {
  const settingsFile = path.join(dirs.configDir, 'settings.json');
  const settings = readSettingsObject(settingsFile);
  mkdirSync(dirs.configDir, { recursive: true });
  writeFileSync(settingsFile, `${JSON.stringify({ ...settings, telemetryEnabled: answer.enabled }, null, 2)}\n`, 'utf8');
  const idFile = path.join(dirs.storeDir, 'telemetry', 'install-id');
  if (answer.installId && !hasInstallId(idFile)) adoptInstallId(answer.installId, idFile);
}

function hasInstallId(file: string): boolean {
  try {
    return isInstallId(readFileSync(file, 'utf8').trim());
  } catch {
    return false;
  }
}
