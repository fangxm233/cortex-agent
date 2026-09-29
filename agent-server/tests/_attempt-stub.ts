// Synthetic `RunAttempt` for tests that mock the orchestration seam's `startAttempt`.

/** The non-promise half of a synthetic attempt. `startAttempt` takes a `RunRequest` plus attempt
 *  config; the old handle's `sessionId` is the attempt's `backendSessionId` (which the run records
 *  as its resume target) and the request's `session.backendSessionId`. */
export function attemptShell(
  input: any,
  backendSessionId: string | null,
  foreground: Promise<any>,
  defaultBackend = 'claude',
) {
  return {
    engine: {
      backend: input?.request?.profile?.backend ?? defaultBackend,
      identity: 'test-engine',
      backendSessionId,
      run: () => ({}),
      steer: () => ({ accepted: false }),
      ingestExternal: () => false,
      respondToDialog: () => false,
      compact: async () => ({}),
      close: async () => {},
      kill: () => true,
    },
    engineRun: {},
    spec: input?.request?.spec,
    backend: input?.request?.profile?.backend ?? defaultBackend,
    identity: null,
    foreground,
    settled: foreground,
    backendSessionId,
    kill: () => true,
  };
}
