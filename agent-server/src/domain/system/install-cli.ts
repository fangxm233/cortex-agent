// input:  CORTEX_VERSION, child_process (execSync, spawn), compareCalVer from server-update-check, withNpmPrefix
// output: cortex install latest CLI
// pos:    CLI module for cortex install — install latest Cortex version from npm
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { execSync, spawn } from 'node:child_process';
import { CORTEX_VERSION } from '@core/version.js';
import { withNpmPrefix } from '@core/utils.js';
import { compareCalVer } from './server-update-check.js';

// ─── CLI Result type ──────────────────────────────────────────────

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// ─── Help ─────────────────────────────────────────────────────────

export function getInstallHelp(): string {
  return [
    'Install the latest version of Cortex from npm',
    '',
    'Usage: cortex install <subcommand>',
    '',
    'Subcommands:',
    '  latest    Install the latest version of @cortex-agent/server from npm',
    '',
    'Options:',
    '  --help, -h    Show this help',
  ].join('\n');
}

// ─── Fetch latest version from npm ────────────────────────────────

function getLatestVersion(): string | null {
  try {
    const result = execSync('npm view @cortex-agent/server version', {
      encoding: 'utf8',
      timeout: 15000,
      stdio: 'pipe',
    }).trim();
    return result || null;
  } catch {
    return null;
  }
}

// ─── Install latest ───────────────────────────────────────────────

async function installLatest(): Promise<CliResult> {
  // 1. Fetch latest version from npm registry
  const latest = getLatestVersion();
  if (!latest) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'Failed to fetch latest version from npm registry. Check your network or npm configuration.\n',
    };
  }

  // 2. Check if already on latest
  if (compareCalVer(latest, CORTEX_VERSION) <= 0) {
    return {
      exitCode: 0,
      stdout: `Already on the latest version (${CORTEX_VERSION}).\n`,
      stderr: '',
    };
  }

  // 3. Show version info before installing
  process.stdout.write(`Current version: ${CORTEX_VERSION}\n`);
  process.stdout.write(`Latest version:  ${latest}\n`);
  process.stdout.write(`Installing @cortex-agent/server@${latest}...\n\n`);

  // 4. Run npm install -g (stdio: 'inherit' so user sees npm progress).
  //    The prefix is pinned to the root the running `cortex` binary lives in — without it
  //    npm falls back to its configured/system prefix (root-owned → EACCES) on machines
  //    that were installed with `--prefix ~/.npm-global` but no .npmrc entry.
  return new Promise((resolve) => {
    const args = withNpmPrefix(['install', '-g', `@cortex-agent/server@${latest}`], 'cortex');
    const child = spawn('npm', args, {
      stdio: 'inherit',
      cwd: '/tmp',
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve({
          exitCode: 0,
          stdout: `\nCortex updated to ${latest}. Restart the daemon to apply: cortex daemon restart\n`,
          stderr: '',
        });
      } else {
        resolve({
          exitCode: 1,
          stdout: '',
          stderr: `npm install failed with exit code ${code}.\n`,
        });
      }
    });

    child.on('error', (err) => {
      resolve({
        exitCode: 1,
        stdout: '',
        stderr: `Failed to start npm install: ${err.message}\n`,
      });
    });
  });
}

// ─── runCli ───────────────────────────────────────────────────────

export async function runCli(argv: string[]): Promise<CliResult> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    return { exitCode: 0, stdout: getInstallHelp(), stderr: '' };
  }

  const sub = argv[0];

  switch (sub) {
    case 'latest':
      return installLatest();
    default:
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Unknown install subcommand: '${sub}'. Use 'cortex install latest' or 'cortex install --help'.\n`,
      };
  }
}
