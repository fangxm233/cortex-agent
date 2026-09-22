// input:  vocabulary, submit callback, design controls
// output: UiTokenLogin
// pos:    Stable browser token login surface
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { useState, type FormEvent } from 'react';
import '../overview/content-surfaces.css';
import { Button, Card } from '@/design';
import { useVocab } from '@/i18n';

const INPUT_CLASS =
  'box-border min-h-11 w-full rounded-[var(--r-control)] border border-proto-line-2 ' +
  'bg-surface-card px-2g py-1.5g text-ui text-state-ink ' +
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
    <div className="content-surface flex min-h-screen items-center justify-center bg-surface-canvas p-2g">
      <Card className="w-full max-w-md" padded>
        <form className="space-y-2g" onSubmit={submit}>
          <h1 className="text-lg font-medium text-state-ink">{L.uiLoginTitle}</h1>
          <p className="text-ui text-[var(--proto-muted)]">{L.uiLoginHint}</p>
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
