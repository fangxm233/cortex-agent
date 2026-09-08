// input:  the frontend build stamp and the native shell version
// output: the app's identity and running versions
// pos:    Help → About Cortex
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { useEffect, useState } from 'react';
import { Modal } from '@/design';
import { useVocab } from '@/i18n';
import { BUILD_STAMP } from '@/lib/build-info';
import { safeInvoke } from '@/lib/native-bridge';

const MONO = "'IBM Plex Mono',monospace";

// Two independently versioned halves: the SPA hot-updates (its identity is the Vite build stamp,
// `MMDD-HHmm·<sha>` — there is no semver for it) while the Rust shell updates separately and
// reports a real version through `plugin:app|version`. Showing both is the only way to read an
// OTA mismatch off the screen.
export function AboutModal({ onClose }: { onClose: () => void }): JSX.Element {
  const L = useVocab();
  const [shellVersion, setShellVersion] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void safeInvoke('plugin:app|version').then((result) => {
      if (alive && result.ok) setShellVersion(result.value);
    });
    return () => { alive = false; };
  }, []);

  const row = (label: string, value: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '5px 0', fontSize: 12.5 }}>
      <span style={{ color: 'var(--proto-muted-2)' }}>{label}</span>
      <span style={{ marginLeft: 'auto', font: `500 11.5px ${MONO}`, color: 'var(--proto-ink)' }}>{value}</span>
    </div>
  );

  return (
    <Modal
      open
      title={L.aboutTitle}
      hideDescription
      description={L.aboutTitle}
      size="custom"
      onOpenChange={(open) => { if (!open) onClose(); }}
      contentStyle={{ width: 380 }}
    >
      <div>
        {row(L.aboutFrontend, BUILD_STAMP)}
        {row(L.aboutShell, shellVersion ?? L.aboutShellBrowser)}
      </div>
    </Modal>
  );
}
