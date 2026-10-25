import { useEffect, useRef, useState, type FormEvent } from 'react';
import '@/design/content-surfaces.css';
import { Button, Card } from '@/design';
import { useVocab } from '@/i18n';

const INPUT_CLASS =
  'box-border min-h-11 w-full rounded-[var(--r-control)] border border-proto-line-2 ' +
  '[background:var(--material-inset-bg)] px-2g py-1.5g text-ui text-state-ink ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-state-run/40';

export interface UiTokenLoginProps {
  /** Resolves true when the token was accepted. Rejects only on a transport failure. */
  onSubmit: (token: string) => Promise<boolean>;
  /** A pairing code from an opened pairing link: filled in and submitted once on mount. */
  initialToken?: string | null;
}

export function UiTokenLogin({ onSubmit, initialToken }: UiTokenLoginProps) {
  const L = useVocab();
  const [token, setToken] = useState(initialToken ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoSubmitted = useRef(false);

  async function attempt(value: string) {
    setBusy(true);
    setError(null);
    try {
      if (!(await onSubmit(value))) setError(L.uiLoginRejected);
    } catch {
      setError(L.uiLoginUnreachable);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!initialToken || autoSubmitted.current) return;
    autoSubmitted.current = true;
    void attempt(initialToken);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, for the link that opened the page
  }, [initialToken]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !token.trim()) return;
    void attempt(token.trim());
  }

  return (
    <div className="content-surface flex min-h-screen items-center justify-center [background:var(--app-backdrop)] p-2g">
      <Card className="w-full max-w-md" padded>
        <form className="space-y-2g" onSubmit={submit}>
          <h1 className="text-lg font-medium text-state-ink">{L.uiLoginTitle}</h1>
          <p className="text-ui text-[var(--proto-muted)]">{L.uiLoginHint}</p>
          <input
            data-ui-login-token
            type="text"
            autoFocus
            autoComplete="off"
            spellCheck={false}
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
