// input:  Modal, vocabulary, build stamp and native navigation
// output: AboutModal with brand, versions and external links
// pos:    Accessible About Cortex dialog
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
import { useEffect, useState } from 'react';
import { Modal, ModalClose } from '@/design/Modal';
import { useVocab } from '@/i18n';
import { BUILD_STAMP } from '@/lib/build-info';
import { openExternalUrl } from '@/lib/external-navigation';
import { safeInvoke, type NativeInvokeResult } from '@/lib/native-bridge';
import './about-modal.css';

const DOCS_URL = 'https://fangxm233.github.io/cortex-agent/';
const PROJECT_URL = 'https://github.com/fangxm233/cortex-agent';

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

// The frontend hot-updates independently of the native shell; retain both identities.
function AboutVersions(): JSX.Element {
  const L = useVocab();
  const version = useShellVersion();
  const fallback = { unavailable: L.aboutShellBrowser, failed: L.aboutShellFailed };
  const shell = version?.ok ? version.value : version ? fallback[version.reason] : L.aboutShellLoading;
  return (
    <dl className="about-versions">
      <div className="about-version-row">
        <dt>{L.aboutFrontend}</dt>
        <dd className="about-version-value">{BUILD_STAMP}</dd>
      </div>
      <div className="about-version-row">
        <dt>{L.aboutShell}</dt>
        <dd className={version?.ok ? 'about-version-value' : 'about-version-status'}>
          <span role="status" aria-busy={!version}>{shell}</span>
        </dd>
      </div>
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
  const links = [[DOCS_URL, L.aboutDocs], [PROJECT_URL, L.aboutProject]];
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
