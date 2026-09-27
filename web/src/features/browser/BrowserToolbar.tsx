import type { ReactNode, RefObject } from 'react';
import { openExternalUrl } from '@/lib/external-navigation';
import { useBrowserCopy } from './browser-copy';
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
  const copy = useBrowserCopy();
  return (
    <div className="browser-toolbar" aria-label={copy.toolbar}>
      <div className="browser-navigation">
        <BrowserButton title={copy.back} disabled={!canGoBack(props.tab.history)} onClick={() => props.onStep('back')}>‹</BrowserButton>
        <BrowserButton title={copy.forward} disabled={!canGoForward(props.tab.history)} onClick={() => props.onStep('forward')}>›</BrowserButton>
        <BrowserButton title={copy.reload} disabled={props.url === null} onClick={props.onReload}>⟳</BrowserButton>
      </div>
      <BrowserAddress {...props} />
      <div className="browser-tools">
        <select className="browser-control" title={copy.viewportWidth} aria-label={copy.viewportWidth} value={props.tab.viewportId}
          onChange={(event) => props.onViewport(event.target.value as ViewportPreset['id'])}>
          {VIEWPORT_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.id === 'fit' ? copy.viewportFit : preset.label}</option>)}
        </select>
        <button type="button" className="browser-control" title={copy.portsTitle}
          aria-expanded={props.portsOpen} aria-controls={`browser-ports-${props.tab.id}`} onClick={props.onTogglePorts}>{copy.ports}</button>
        <BrowserButton title={copy.openExternal} disabled={props.url === null}
          onClick={() => { if (props.url) void openExternalUrl(props.url); }}>↗</BrowserButton>
      </div>
    </div>
  );
}

function BrowserAddress({ tab, inputRef, onDraft, onNavigate, onResetDraft }: ToolbarProps): JSX.Element {
  const copy = useBrowserCopy();
  const origin = browserTabForwardSource(tab);
  return (
    <div className="browser-address">
      {origin && <span className="browser-origin" data-forward-origin={origin} title={copy.forwardedFrom.replace('{source}', origin)}>{origin} →</span>}
      <input ref={inputRef} aria-label={copy.address} value={tab.draft} spellCheck={false}
        placeholder={copy.addressPlaceholder} onChange={(event) => onDraft(event.target.value)}
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
