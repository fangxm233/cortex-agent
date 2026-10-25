import { BUILD_STAMP } from '@/lib/build-info';
import { currentRouteTemplate } from './route-template';
import { telemetryQueue, type WebCrashKind, type WebTelemetryReport } from './report-queue';

// Browser noise that is not a Cortex failure: the cross-origin script placeholder carries no
// detail at all, and the ResizeObserver loop notice is a benign layout warning.
const IGNORED_MESSAGES = [/^Script error\.?$/i, /^ResizeObserver loop/i];

interface ErrorParts { name: string; message: string; stack: string }

function errorParts(value: unknown): ErrorParts {
  if (value instanceof Error) {
    return { name: value.name || 'Error', message: value.message, stack: value.stack ?? '' };
  }
  const name = value === null ? 'null' : typeof value;
  return { name: `NonError:${name}`, message: String(value), stack: '' };
}

/** The crash report for one error, cut to the wire limits. */
export function crashReport(crashKind: WebCrashKind, error: unknown, extraStack = ''): WebTelemetryReport {
  const parts = errorParts(error);
  return {
    kind: 'crash',
    crashKind,
    errorName: parts.name.slice(0, 200),
    message: parts.message.slice(0, 2_000),
    stack: `${parts.stack}${extraStack}`.slice(0, 20_000),
    route: currentRouteTemplate(),
    buildStamp: BUILD_STAMP.slice(0, 60),
    uptimeS: typeof performance === 'undefined' ? null : Math.round(performance.now() / 1000),
  };
}

export function isIgnoredError(message: string): boolean {
  return IGNORED_MESSAGES.some((pattern) => pattern.test(message));
}

function onWindowError(event: ErrorEvent): void {
  if (isIgnoredError(event.message ?? '')) return;
  const error = event.error ?? new Error(event.message || 'Unknown error');
  telemetryQueue.enqueue(crashReport('windowError', error));
}

function onUnhandledRejection(event: PromiseRejectionEvent): void {
  const parts = errorParts(event.reason);
  if (isIgnoredError(parts.message)) return;
  telemetryQueue.enqueue(crashReport('unhandledRejection', event.reason));
}

/** Install once, before the first render, so a crash during it is still seen. */
export function installGlobalErrorCapture(target: Window = window): () => void {
  target.addEventListener('error', onWindowError);
  target.addEventListener('unhandledrejection', onUnhandledRejection);
  return () => {
    target.removeEventListener('error', onWindowError);
    target.removeEventListener('unhandledrejection', onUnhandledRejection);
  };
}

/** A render error caught by the root boundary, with React's component stack appended. */
export function reportRenderError(error: unknown, componentStack?: string | null): void {
  const extra = componentStack ? `\n--- component stack ---${componentStack}` : '';
  telemetryQueue.enqueue(crashReport('renderError', error, extra));
}
