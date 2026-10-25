import type { CSSProperties, MouseEvent } from 'react';
import { useVocab } from '@/i18n';
import { isNativeShell } from '@/lib/desktop-config';
import { openExternalUrl } from '@/lib/external-navigation';

/** "Learn more" → the telemetry docs in the UI language. Native shells open the system browser. */
export function TelemetryDocsLink({ className, style }: { className?: string; style?: CSSProperties }) {
  const L = useVocab();
  const open = (event: MouseEvent) => {
    event.preventDefault();
    void openExternalUrl(L.tmDocsUrl);
  };
  return <a href={L.tmDocsUrl} target="_blank" rel="noreferrer" className={className} style={style}
    data-telemetry-docs onClick={isNativeShell() ? open : undefined}>{L.tmLearnMore}</a>;
}
