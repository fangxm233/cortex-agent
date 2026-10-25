import { captureCrash } from './crash.js';

/** The daemon hands the next app process the facts of the previous one's unexpected exit. */
export const CHILD_EXIT_ENV = 'CORTEX_CHILD_EXIT';

export interface ChildExitInfo {
  code: number | null;
  signal: string | null;
  uptimeMs: number;
  backoffMs: number;
}

export function encodeChildExit(info: ChildExitInfo): string {
  return JSON.stringify(info);
}

function decode(raw: string | undefined): ChildExitInfo | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ChildExitInfo>;
    if (typeof value.uptimeMs !== 'number' || typeof value.backoffMs !== 'number') return null;
    const code = Number.isInteger(value.code) ? value.code! : null;
    const signal = typeof value.signal === 'string' ? value.signal.slice(0, 20) : null;
    return { code, signal, uptimeMs: Math.max(0, value.uptimeMs), backoffMs: Math.max(0, Math.round(value.backoffMs)) };
  } catch {
    return null;
  }
}

/** At boot: report the crash the daemon recovered from, if any. */
export function captureChildExitFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  const info = decode(env[CHILD_EXIT_ENV]);
  if (!info) return;
  captureCrash({
    component: 'server',
    kind: 'childExit',
    errorName: 'ChildExit',
    message: info.signal ? `signal ${info.signal}` : `exit code ${info.code ?? 'unknown'}`,
    stack: '',
    uptimeS: Math.round(info.uptimeMs / 1000),
    exit: { code: info.code, signal: info.signal, backoffMs: info.backoffMs },
  });
}
