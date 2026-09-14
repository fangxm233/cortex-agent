// input:  argv (cortex doctor [--json] [--fix] [--help]) + optional injected deps
// output: cmdDoctor(args) → CliResult; getDoctorHelp() → help string
// pos:    CLI wrapper for `cortex doctor`. Runs the diagnostic engine, optionally
//         applies safe idempotent fixes, and renders a plain-text or JSON report.
//         Exit code 1 when any check fails, else 0 (CLI Rule ④/exit-code).

import { formatHelp } from '@core/cli-utils.js';
import {
  runDiagnostics,
  applySafeFixes,
  createDefaultDoctorDeps,
  createDefaultFixActuators,
  type DoctorDeps,
  type DoctorReport,
  type FixActuators,
  type FixOutcome,
  type CheckStatus,
} from '../domain/system/doctor.js';

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CmdDoctorDeps {
  diag: DoctorDeps;
  fix: FixActuators;
}

export function getDoctorHelp(): string {
  return formatHelp({
    name: 'cortex doctor',
    description: 'Health-check the Cortex installation — runtime, backend/login, messaging platform, gateway.',
    usage: 'cortex doctor [options]',
    options: [
      { flag: '--fix', description: 'Apply safe, idempotent repairs (generate missing tokens, create dirs, rebuild mcp-config)' },
      { flag: '--json', description: 'Emit the report as JSON' },
      { flag: '--help, -h', description: 'Show this help' },
    ],
    examples: [
      { description: 'Run a read-only diagnosis', command: 'cortex doctor' },
      { description: 'Diagnose and auto-repair fixable issues', command: 'cortex doctor --fix' },
      { description: 'Machine-readable output', command: 'cortex doctor --json' },
    ],
  });
}

const MARKER: Record<CheckStatus, string> = {
  pass: '[OK]  ',
  warn: '[WARN]',
  fail: '[FAIL]',
  skip: '[--]  ',
};

function renderText(report: DoctorReport, fixes: FixOutcome[]): string {
  const lines: string[] = ['Cortex Doctor', ''];
  for (const section of report.sections) {
    lines.push(section.title);
    for (const c of section.checks) {
      lines.push(`  ${MARKER[c.status]} ${c.label} — ${c.detail}`);
      if (c.hint && (c.status === 'fail' || c.status === 'warn')) lines.push(`         ↳ ${c.hint}`);
    }
    lines.push('');
  }

  if (fixes.length > 0) {
    lines.push('Fixes applied:');
    for (const f of fixes) lines.push(`  ${f.applied ? '[OK]  ' : '[--]  '} ${f.label} — ${f.detail}`);
    lines.push('');
  }

  const { pass, warn, fail } = report.counts;
  lines.push(`Summary: ${pass} passed, ${warn} warning${warn === 1 ? '' : 's'}, ${fail} failed`);
  if (fail > 0 || warn > 0) {
    const anyFixable = report.sections.some(s => s.checks.some(c => c.fixable && (c.status === 'fail' || c.status === 'warn')));
    if (anyFixable) lines.push('Run `cortex doctor --fix` to auto-repair fixable issues.');
  }
  return lines.join('\n').trimEnd() + '\n';
}

export async function cmdDoctor(args: string[], override?: Partial<CmdDoctorDeps>): Promise<CliResult> {
  if (args.includes('--help') || args.includes('-h')) {
    return { exitCode: 0, stdout: getDoctorHelp(), stderr: '' };
  }

  const asJson = args.includes('--json');
  const doFix = args.includes('--fix');

  const diag = override?.diag ?? createDefaultDoctorDeps();
  const fix = override?.fix ?? createDefaultFixActuators();

  let report = await runDiagnostics(diag);
  let fixes: FixOutcome[] = [];
  if (doFix) {
    fixes = await applySafeFixes(report, diag, fix);
    report = await runDiagnostics(diag);
  }

  const stdout = asJson
    ? JSON.stringify({ ...report, fixes: doFix ? fixes : undefined }, null, 2) + '\n'
    : renderText(report, fixes);

  return { exitCode: report.ok ? 0 : 1, stdout, stderr: '' };
}
