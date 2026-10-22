import type { ReactNode, RefObject } from 'react';
import { openExternalUrl } from '@/lib/external-navigation';
import { useVocabOptional } from '@/i18n';
import { Select } from '@/design';
import { browserTabForwardSource, canGoBack, canGoForward, VIEWPORT_PRESETS, type BrowserTabState, type ViewportPreset } from './browser-target';

interface ToolbarProps {
  tab: BrowserTabState;
  url: string | null;
  inputRef: RefObject<HTMLInputElement>;
  portsOpen: boolean;
  onStep: (dir: 'back' | 'forward') => void;
  onReload: () => void;
  onDraft: (draft: string) => void;
  onNavigate: () => void;
  onResetDraft: () => void;
  onViewport: (id: ViewportPreset['id']) => void;
  onTogglePorts: () => void;
}

export function BrowserToolbar(props: ToolbarProps): JSX.Element {
  const L = useVocabOptional();
  return (
    <div className="browser-toolbar" aria-label={L.brToolbar}>
      <div className="browser-navigation">
        <BrowserButton title={L.tbBack} disabled={!canGoBack(props.tab.history)} onClick={() => props.onStep('back')}>‹</BrowserButton>
        <BrowserButton title={L.tbForward} disabled={!canGoForward(props.tab.history)} onClick={() => props.onStep('forward')}>›</BrowserButton>
        <BrowserButton title={L.brReload} disabled={props.url === null} onClick={props.onReload}>⟳</BrowserButton>
      </div>
      <BrowserAddress {...props} />
      <div className="browser-tools">
        <Select density="bare" className="browser-control" title={L.brViewportWidth} aria-label={L.brViewportWidth}
          value={props.tab.viewportId} onValueChange={props.onViewport}
          options={VIEWPORT_PRESETS.map(preset => ({ value: preset.id, label: preset.id === 'fit' ? L.brViewportFit : preset.label }))} />
        <button type="button" className="browser-control" title={L.brPortsTitle}
          aria-expanded={props.portsOpen} aria-controls={`browser-ports-${props.tab.id}`} onClick={props.onTogglePorts}>{L.brPorts}</button>
        <BrowserButton title={L.brOpenExternal} disabled={props.url === null}
          onClick={() => { if (props.url) void openExternalUrl(props.url); }}>↗</BrowserButton>
      </div>
    </div>
  );
}

function BrowserAddress({ tab, inputRef, onDraft, onNavigate, onResetDraft }: ToolbarProps): JSX.Element {
  const L = useVocabOptional();
  const origin = browserTabForwardSource(tab);
  return (
    <div className="browser-address">
      {origin && <span className="browser-origin" data-forward-origin={origin} title={L.brForwardedFrom.replace('{source}', origin)}>{origin} →</span>}
      <input ref={inputRef} aria-label={L.brAddress} value={tab.draft} spellCheck={false}
        placeholder={L.brAddressPlaceholder} onChange={(event) => onDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onNavigate();
          if (event.key === 'Escape') onResetDraft();
        }} />
    </div>
  );
}

export function BrowserButton({ children, title, disabled, onClick }: {
  children: ReactNode; title: string; disabled?: boolean; onClick: () => void;
}): JSX.Element {
  return <button type="button" className="browser-control browser-icon" title={title} aria-label={title}
    disabled={disabled} onClick={onClick}>{children}</button>;
}
