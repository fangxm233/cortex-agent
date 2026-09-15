// input:  the vocabulary and a submit callback
// output: the browser token-login screen
// pos:    Shown by UiAuthGate when this browser holds no session yet
// >>> Once updated, update this header and parent CORTEX.md <<<

import { useState, type FormEvent } from 'react';
import { Button, Card } from '@/design';
import { useVocab } from '@/i18n';

const INPUT_CLASS =
  'box-border min-h-11 w-full rounded-card border border-proto-line-3 ' +
  'bg-surface-canvas-alt px-2g py-1.5g text-ui text-state-ink shadow-sm ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-state-run/40';

export interface UiTokenLoginProps {
  /** Resolves true when the token was accepted. Rejects only on a transport failure. */
  onSubmit: (token: string) => Promise<boolean>;
}

export function UiTokenLogin({ onSubmit }: UiTokenLoginProps) {
  const L = useVocab();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !token.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (!(await onSubmit(token.trim()))) setError(L.uiLoginRejected);
    } catch {
      setError(L.uiLoginUnreachable);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-canvas p-2g">
      <Card className="w-full max-w-md" padded>
        <form className="space-y-2g" onSubmit={submit}>
          <h1 className="text-lg font-medium text-state-ink">{L.uiLoginTitle}</h1>
          <p className="text-ui text-state-ink/70">{L.uiLoginHint}</p>
          <input
            data-ui-login-token
            type="password"
            autoFocus
            autoComplete="current-password"
            aria-label={L.uiLoginTokenLabel}
            placeholder={L.uiLoginTokenLabel}
            className={INPUT_CLASS}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          {error ? <p className="text-ui text-state-fail">{error}</p> : null}
          <Button type="submit" variant="primary" className="w-full" disabled={busy || !token.trim()}>
            {busy ? L.uiLoginBusy : L.uiLoginSubmit}
          </Button>
        </form>
      </Card>
    </div>
  );
}
