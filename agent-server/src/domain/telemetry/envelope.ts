import os from 'node:os';
import { getLocale } from '@core/i18n.js';
import { INSTALL_ROOT } from '@core/paths.js';
import { npmPrefixFromInstallRoot } from '@core/utils.js';
import { CORTEX_VERSION } from '@core/version.js';
import { getInstallId } from './install-id.js';
import { TELEMETRY_SCHEMA_VERSION, type TelemetryEnvelope } from './schema.js';

type InstallForm = TelemetryEnvelope['installForm'];
type OsName = TelemetryEnvelope['os'];

const KNOWN_OS: readonly string[] = ['linux', 'darwin', 'win32', 'android'];

/** The desktop service sets CORTEX_NPM_PREFIX; a global npm layout is the npm form. */
export function detectInstallForm(
  env: NodeJS.ProcessEnv = process.env,
  installRoot: string = INSTALL_ROOT,
): InstallForm {
  if (env.CORTEX_NPM_PREFIX?.trim()) return 'desktop';
  return npmPrefixFromInstallRoot(installRoot, '@cortex-agent/server') ? 'npm' : 'other';
}

function osName(platform: string): OsName {
  return KNOWN_OS.includes(platform) ? platform as OsName : 'other';
}

function majorOf(release: string): string {
  return (release.split('.')[0] ?? '').slice(0, 20);
}

export function buildEnvelope(channel: TelemetryEnvelope['channel'], now = new Date()): TelemetryEnvelope {
  return {
    schema: TELEMETRY_SCHEMA_VERSION,
    installId: getInstallId(),
    sentAt: now.toISOString(),
    version: CORTEX_VERSION.slice(0, 40),
    channel,
    installForm: detectInstallForm(),
    os: osName(process.platform),
    osRelease: majorOf(os.release()),
    arch: process.arch.slice(0, 20),
    nodeMajor: Number.parseInt(process.versions.node, 10),
    uiLang: getLocale(),
  };
}
