import { isTelemetryActive } from './gate.js';
import { admitCrash, wipeCrashLimits } from './crash-limits.js';
import type { ClientKind } from './client-kind.js';
import { groupKeyOf, redactMessage, redactStack } from './redact.js';
import type { CrashEvent } from './schema.js';
import { recordTelemetryEvent, registerTelemetryHooks } from './service.js';

registerTelemetryHooks({ wipe: () => wipeCrashLimits() });

export interface CrashInput {
  component: CrashEvent['component'];
  kind: CrashEvent['kind'];
  errorName: string;
  message: string;
  stack: string;
  uptimeS?: number | null;
  route?: string | null;
  buildStamp?: string | null;
  client?: ClientKind | null;
  exit?: CrashEvent['exit'];
  at?: Date;
}

function errorNameOf(error: unknown): string {
  if (error instanceof Error) return error.name || error.constructor?.name || 'Error';
  return typeof error === 'object' && error !== null ? 'NonErrorObject' : `Non${typeof error}`;
}

/** Name, message and stack of whatever was thrown, before redaction. */
export function describeThrown(error: unknown): Pick<CrashInput, 'errorName' | 'message' | 'stack'> {
  if (error instanceof Error) {
    return { errorName: errorNameOf(error), message: error.message ?? '', stack: error.stack ?? '' };
  }
  return { errorName: errorNameOf(error), message: '', stack: '' };
}

/** Redact and shape a crash; the group key comes from the redacted stack. */
export function buildCrashEvent(input: CrashInput, suppressed = 0): CrashEvent {
  const errorName = redactMessage(input.errorName).slice(0, 80) || 'Error';
  const stack = redactStack(input.stack);
  return {
    type: 'crash',
    at: (input.at ?? new Date()).toISOString(),
    component: input.component,
    kind: input.kind,
    errorName,
    message: redactMessage(input.message),
    stack,
    groupKey: input.kind === 'childExit' ? childExitGroup(input.exit) : groupKeyOf(errorName, stack),
    uptimeS: input.uptimeS ?? null,
    route: input.route?.slice(0, 80) ?? null,
    buildStamp: input.buildStamp?.slice(0, 60) ?? null,
    client: input.client ?? null,
    exit: input.exit ?? null,
    suppressed,
  };
}

function childExitGroup(exit: CrashEvent['exit']): string {
  return exit?.signal ? `ChildExit@${exit.signal}` : `ChildExit@code:${exit?.code ?? 'unknown'}`;
}

/**
 * Record a crash: rate-limited, appended synchronously, uploaded within seconds when the
 * service runs in this process. Never throws.
 */
export function captureCrash(input: CrashInput): void {
  try {
    if (!isTelemetryActive()) return;
    const draft = buildCrashEvent(input);
    const admission = admitCrash(draft.groupKey);
    if (!admission.send) return;
    recordTelemetryEvent({ ...draft, suppressed: admission.suppressed }, { urgent: true });
  } catch { /* crash reporting must never add a crash */ }
}

export function captureProcessCrash(
  component: 'server' | 'daemon', kind: 'uncaughtException' | 'unhandledRejection', error: unknown,
): void {
  captureCrash({ component, kind, ...describeThrown(error), uptimeS: Math.round(process.uptime()) });
}
