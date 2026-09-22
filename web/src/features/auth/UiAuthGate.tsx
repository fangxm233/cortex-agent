// input:  UI session probe, native configuration, UiTokenLogin
// output: UiAuthGate
// pos:    Browser session gate and connection notice
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isNativeShell, readDesktopConfig } from '@/lib/desktop-config';
import { probeUiSession, uiLogin, type UiSessionState } from '@/lib/ui-session';
import { useVocab } from '@/i18n';
import { UiTokenLogin } from './UiTokenLogin';

type GateState =
  | { kind: 'probing' }
  | { kind: 'in' }
  | { kind: 'form' }
  | { kind: 'no-login' } // server has token login switched off and we are not authenticated
  | { kind: 'unreachable' };

function stateFor(session: UiSessionState): GateState {
  if (session.authenticated) return { kind: 'in' };
  return session.tokenLogin ? { kind: 'form' } : { kind: 'no-login' };
}

/**
 * Holds the app back until the browser is known to pass the server's auth gate.
 *
 * Without this, an unauthenticated browser mounts the whole tree and every query fails with a 401
 * the user cannot act on. The probe is one request and runs only in browser mode.
 */
export function UiAuthGate({ children }: { children: ReactNode }) {
  // Native shells are credentialed at launch; their config never appears later, so reading it once
  // is enough and keeps them from paying for a probe that does not apply to them.
  const skip = useMemo(() => isNativeShell() || !!readDesktopConfig(), []);
  const [state, setState] = useState<GateState>(() => (skip ? { kind: 'in' } : { kind: 'probing' }));

  const probe = useCallback(async () => {
    try {
      setState(stateFor(await probeUiSession()));
    } catch {
      setState({ kind: 'unreachable' });
    }
  }, []);

  useEffect(() => {
    if (!skip) void probe();
  }, [skip, probe]);

  const submit = useCallback(
    async (token: string) => {
      const res = await uiLogin(token);
      if (!res.ok) return false;
      await probe(); // re-probe rather than assume: the server is the authority on what we now are
      return true;
    },
    [probe],
  );

  if (state.kind === 'in') return <>{children}</>;
  if (state.kind === 'probing') return null; // one round trip; a spinner would only flash
  if (state.kind === 'form') return <UiTokenLogin onSubmit={submit} />;
  return <GateNotice kind={state.kind} onRetry={probe} />;
}

function GateNotice({ kind, onRetry }: { kind: 'no-login' | 'unreachable'; onRetry: () => void }) {
  const L = useVocab();
  return (
    <div className="content-surface flex min-h-screen items-center justify-center [background:var(--app-backdrop)] p-2g">
      <div className="max-w-md space-y-1g rounded-[var(--r-card)] border border-proto-line-2 [background:var(--material-card-bg)] shadow-[shadow:var(--material-card-shadow)] p-3g text-center">
        <p className="text-ui text-state-ink">
          {kind === 'unreachable' ? L.uiLoginUnreachable : L.uiLoginDisabled}
        </p>
        <button type="button" className="text-ui text-state-run underline" onClick={onRetry}>
          {L.uiLoginRetry}
        </button>
      </div>
    </div>
  );
}
