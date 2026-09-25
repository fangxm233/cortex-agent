// input:  BrowserTabState, viewport presets, navigation callbacks
// output: BrowserToolbar, BrowserButton
// pos:    Compact wrapping browser address and navigation controls
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import type { ReactNode, RefObject } from 'react';
import { openExternalUrl } from '@/lib/external-navigation';
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
  return (
    <div className="browser-toolbar" aria-label="Browser controls">
      <div className="browser-navigation">
        <BrowserButton title="Back" disabled={!canGoBack(props.tab.history)} onClick={() => props.onStep('back')}>‹</BrowserButton>
        <BrowserButton title="Forward" disabled={!canGoForward(props.tab.history)} onClick={() => props.onStep('forward')}>›</BrowserButton>
        <BrowserButton title="Reload" disabled={props.url === null} onClick={props.onReload}>⟳</BrowserButton>
      </div>
      <BrowserAddress {...props} />
      <div className="browser-tools">
        <select className="browser-control" title="Viewport width" aria-label="Viewport width" value={props.tab.viewportId}
          onChange={(event) => props.onViewport(event.target.value as ViewportPreset['id'])}>
          {VIEWPORT_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
        </select>
        <button type="button" className="browser-control" title="Ports listening on the server or a connected device"
          aria-expanded={props.portsOpen} aria-controls={`browser-ports-${props.tab.id}`} onClick={props.onTogglePorts}>Ports</button>
        <BrowserButton title="Open in system browser" disabled={props.url === null}
          onClick={() => { if (props.url) void openExternalUrl(props.url); }}>↗</BrowserButton>
      </div>
    </div>
  );
}

function BrowserAddress({ tab, inputRef, onDraft, onNavigate, onResetDraft }: ToolbarProps): JSX.Element {
  const origin = browserTabForwardSource(tab);
  return (
    <div className="browser-address">
      {origin && <span className="browser-origin" data-forward-origin={origin} title={`Forwarded from ${origin}`}>{origin} →</span>}
      <input ref={inputRef} aria-label="Browser address" value={tab.draft} spellCheck={false}
        placeholder="Port or http://host:port" onChange={(event) => onDraft(event.target.value)}
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
