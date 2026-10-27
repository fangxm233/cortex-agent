import { useEffect, useState, type ReactNode } from 'react';
import { Modal, ModalClose } from '@/design/Modal';
import { defineModal, type ModalActions } from '@/design/modal-registry';
import { useVocab } from '@/i18n';
import { BUILD_STAMP } from '@/lib/build-info';
import { openExternalUrl } from '@/lib/external-navigation';
import { safeInvoke, type NativeInvokeResult } from '@/lib/native-bridge';
import { useServerVersion } from './useServerVersion';
import './about-modal.css';

export const DOCS_URL = 'https://fangxm233.github.io/cortex-agent/';
const PROJECT_URL = 'https://github.com/fangxm233/cortex-agent';
export const ISSUES_URL = `${PROJECT_URL}/issues`;

function useShellVersion(): NativeInvokeResult<string> | null {
  const [version, setVersion] = useState<NativeInvokeResult<string> | null>(null);
  useEffect(() => {
    let alive = true;
    void safeInvoke('plugin:app|version').then((result) => {
      if (alive) setVersion(result);
    });
    return () => { alive = false; };
  }, []);
  return version;
}

function AboutBrand(): JSX.Element {
  const L = useVocab();
  return (
    <header className="about-brand">
      <img src="/apple-touch-icon.png" alt="" width={72} height={72} />
      <h2>Cortex</h2>
      <p>{L.aboutDescription}</p>
    </header>
  );
}

interface VersionText {
  text: string;
  ok: boolean;
  busy: boolean;
}

function useShellVersionText(): VersionText {
  const L = useVocab();
  const version = useShellVersion();
  if (version?.ok) return { text: version.value, ok: true, busy: false };
  if (!version) return { text: L.aboutVersionLoading, ok: false, busy: true };
  const fallback = { unavailable: L.aboutShellBrowser, failed: L.aboutVersionFailed };
  return { text: fallback[version.reason], ok: false, busy: false };
}

function useServerVersionText(): VersionText {
  const L = useVocab();
  const { version, failed } = useServerVersion();
  if (version) return { text: version, ok: true, busy: false };
  if (failed) return { text: L.aboutVersionFailed, ok: false, busy: false };
  return { text: L.aboutVersionLoading, ok: false, busy: true };
}

function VersionRow({ label, children, ok = true }: { label: string; children: ReactNode; ok?: boolean }): JSX.Element {
  return (
    <div className="about-version-row">
      <dt>{label}</dt>
      <dd className={ok ? 'about-version-value' : 'about-version-status'}>{children}</dd>
    </div>
  );
}

function AsyncVersionRow({ label, version }: { label: string; version: VersionText }): JSX.Element {
  return (
    <VersionRow label={label} ok={version.ok}>
      <span role="status" aria-busy={version.busy}>{version.text}</span>
    </VersionRow>
  );
}

// Server, frontend and native shell each update on their own; retain all three identities.
function AboutVersions(): JSX.Element {
  const L = useVocab();
  return (
    <dl className="about-versions">
      <AsyncVersionRow label={L.aboutServer} version={useServerVersionText()} />
      <VersionRow label={L.aboutFrontend}>{BUILD_STAMP}</VersionRow>
      <AsyncVersionRow label={L.aboutShell} version={useShellVersionText()} />
    </dl>
  );
}

function ExternalArrow(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 12 12 4M4 4h8v8" stroke="currentColor" strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AboutLinks(): JSX.Element {
  const L = useVocab();
  const [failed, setFailed] = useState(false);
  const links = [[DOCS_URL, L.aboutDocs], [PROJECT_URL, L.aboutProject], [ISSUES_URL, L.aboutIssues]];
  return (
    <footer className="about-footer">
      <div className="about-links">
        {links.map(([url, label]) => (
          <a key={url} href={url} onClick={(event) => {
            event.preventDefault();
            setFailed(false);
            void openExternalUrl(url).catch(() => setFailed(true));
          }}>{label}<ExternalArrow /></a>
        ))}
      </div>
      {failed && <p className="about-link-error" role="alert">{L.aboutLinkError}</p>}
    </footer>
  );
}

export function AboutModal({ onClose }: { onClose: () => void }): JSX.Element {
  const L = useVocab();
  return (
    <Modal open chrome="bare" title={L.aboutTitle} description={L.aboutDescription}
      showClose={false} contentDataAttributes={{ 'data-about-dialog': true }}
      onOpenChange={(open) => { if (!open) onClose(); }}>
      <ModalClose className="about-close" aria-label={L.winClose}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </ModalClose>
      <AboutBrand />
      <AboutVersions />
      <AboutLinks />
    </Modal>
  );
}

const aboutModal = defineModal('shell.about');

export function useAboutModal(): ModalActions<void> {
  return aboutModal.useModalActions();
}

export function AboutModalHost(): JSX.Element | null {
  const { isOpen, close } = aboutModal.useModal();
  if (!isOpen) return null;
  return <AboutModal onClose={close} />;
}
