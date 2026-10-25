import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLang, useVocab } from '@/i18n';
import { invokeNative, safeInvoke } from '@/lib/native-bridge';
import { nativeErrorMessage } from '@/lib/native-error';
import { normalizeServerUrl, probeFailureText, probeServer } from './remote-connect';
import { BackIcon, ChevronIcon, DownloadIcon, MonitorIcon, ServerIcon } from './onboarding-icons';
import { WORKBENCH_PAGE } from './local-setup';
import { recordSetupLang } from './setup-telemetry';

export function ChooseScreen({ onLocal, onRemote }: { onLocal: () => void; onRemote: () => void }) {
  const L = useVocab();
  const lang = useLang();
  // The shell reports setup steps from here on, in the language chosen for setup.
  const install = () => { recordSetupLang(lang); onLocal(); };
  return <section>
    <div className="setup-eyebrow">{L.onbChooseEyebrow}</div>
    <h1>{L.onbChooseTitle}</h1>
    <p className="setup-intro">{L.onbChooseIntro}</p>
    <div className="setup-card"><div className="setup-card-body">
      <div className="onb-choice-heading">
        <div className="onb-choice-icon"><MonitorIcon /></div>
        <div><h2>{L.onbLocalTitle}</h2><p className="onb-choice-desc">{L.onbLocalDesc}</p></div>
        <span className="setup-pill setup-good">{L.onbRecommended}</span>
      </div>
      <p className="setup-hint">{L.onbLocalHint}</p>
      <div className="onb-facts"><span>{L.onbFactLocal}</span><span>{L.onbFactBackground}</span><span>{L.onbFactNode}</span></div>
      <button type="button" className="setup-button setup-primary onb-wide" data-action="onb-local" onClick={install}>
        {L.onbInstall}<DownloadIcon />
      </button>
    </div></div>
    <button type="button" className="setup-card onb-remote-choice" data-action="onb-remote" onClick={onRemote}>
      <div className="onb-choice-icon"><ServerIcon /></div>
      <div><strong>{L.onbRemoteTitle}</strong><p>{L.onbRemoteDesc}</p></div>
      <span className="onb-chevron"><ChevronIcon /></span>
    </button>
    <p className="setup-footnote">{L.onbLaterNote}</p>
  </section>;
}

type Status = { text: string; tone: 'pending' | 'ok' | 'error' } | null;

export function RemoteConnectScreen({ onBack, leave = page => window.location.replace(page) }: {
  /** Absent on the mobile shell, where connecting a server is the only option. */
  onBack?: () => void;
  leave?: (page: string) => void;
}) {
  const L = useVocab();
  const [serverUrl, setServerUrl] = useState('');
  const [token, setToken] = useState('');
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    urlInput.current?.focus();
    void safeInvoke('get_connection_config').then(result => {
      if (result.ok && result.value.serverUrl) setServerUrl(previous => previous || result.value.serverUrl!);
    });
  }, []);

  const run = async (save: boolean) => {
    if (busy || form.current?.reportValidity() === false) return;
    const connection = { serverUrl: normalizeServerUrl(serverUrl), token: token.trim() };
    if (!connection.token) { setStatus({ text: L.onbTokenRequired, tone: 'error' }); return; }
    setBusy(true);
    setStatus({ text: L.onbConnecting, tone: 'pending' });
    try {
      const outcome = await probeServer(connection.serverUrl, connection.token);
      if (outcome !== 'ok') { setStatus({ text: probeFailureText(outcome, L), tone: 'error' }); return; }
      if (!save) { setStatus({ text: L.onbVerified, tone: 'ok' }); return; }
      await invokeNative('connect', connection);
      setStatus({ text: L.onbConnected, tone: 'ok' });
      leave(WORKBENCH_PAGE);
    } catch (error) {
      setStatus({ text: nativeErrorMessage(error), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); void run(true); };

  return <section>
    {onBack ? <button type="button" className="onb-back" disabled={busy} onClick={onBack}><BackIcon />{L.onbAllOptions}</button> : null}
    <div className="setup-eyebrow">{L.onbRemoteEyebrow}</div>
    <h1>{L.onbRemoteHeading}</h1>
    <p className="setup-intro">{L.onbRemoteIntro}</p>
    <form ref={form} className="setup-card" onSubmit={submit}>
      <div className="setup-card-body">
        <label className="onb-field" htmlFor="onb-server-url"><span className="onb-label">{L.onbServerAddress}</span>
          <input ref={urlInput} id="onb-server-url" className="setup-input onb-mono" type="url" required spellCheck={false}
            autoComplete="off" placeholder={L.onbServerPlaceholder} disabled={busy} value={serverUrl}
            onChange={event => setServerUrl(event.target.value)} /></label>
        <label className="onb-field" htmlFor="onb-token"><span className="onb-label">{L.onbClientToken}</span>
          <input id="onb-token" className="setup-input onb-mono" type="password" required autoComplete="new-password"
            placeholder={L.onbTokenPlaceholder} disabled={busy} value={token} onChange={event => setToken(event.target.value)} />
          <span className="setup-hint">{L.onbTokenHint}</span></label>
        {status ? <div className="onb-connection-status" role="status" aria-live="polite" data-tone={status.tone}>{status.text}</div> : null}
      </div>
      <div className="onb-action-bar">
        <button type="button" className="setup-button" data-action="onb-test" disabled={busy} onClick={() => void run(false)}>{L.onbTest}</button>
        <button type="submit" className="setup-button setup-primary" data-action="onb-connect" disabled={busy}>{L.onbConnect}<ChevronIcon /></button>
      </div>
    </form>
  </section>;
}
