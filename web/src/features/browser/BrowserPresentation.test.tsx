// input:  browser presentation components, react-test-renderer
// output: browser chrome accessibility regression tests
// pos:    Verify address, port selection and notice semantics
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { createRef } from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { BrowserToolbar } from './BrowserToolbar';
import { BrowserNotice, PortsPanel, type PortPickerState } from './BrowserPanels';
import { createBrowserTab } from './browser-target';

function toolbar(portsOpen = false) {
  return create(<BrowserToolbar tab={createBrowserTab('preview')} url={null} inputRef={createRef()}
    portsOpen={portsOpen} onStep={vi.fn()} onReload={vi.fn()} onDraft={vi.fn()} onNavigate={vi.fn()}
    onResetDraft={vi.fn()} onViewport={vi.fn()} onTogglePorts={vi.fn()} />);
}

const portState: PortPickerState = {
  open: true, ports: [{ port: 5173, address: '127.0.0.1', process: 'vite' }], error: null,
  device: 'desk', devices: [{ device: 'desk', platform: 'win32' }],
};

describe('browser presentation', () => {
  it('labels compact controls and exposes disabled navigation and expanded ports', () => {
    const renderer = toolbar(true);
    expect(renderer.root.findByType('input').props['aria-label']).toBe('Browser address');
    expect(renderer.root.findByType('select').props['aria-label']).toBe('Viewport width');
    for (const label of ['Back', 'Forward', 'Reload', 'Open in system browser']) {
      expect(renderer.root.findByProps({ 'aria-label': label }).props.disabled).toBe(true);
    }
    const ports = renderer.root.findByProps({ title: 'Ports listening on the server or a connected device' });
    expect(ports.props['aria-expanded']).toBe(true);
    expect(ports.props['aria-controls']).toBe('browser-ports-preview');
    act(() => renderer.unmount());
  });

  it('exposes selected devices and retains device and port callbacks', () => {
    const onDevice = vi.fn();
    const onPort = vi.fn(async () => {});
    const renderer = create(<PortsPanel id="browser-ports-preview" state={portState} onDevice={onDevice} onPort={onPort} />);
    const buttons = renderer.root.findAllByType('button');
    expect(buttons[0]!.props['aria-pressed']).toBe(false);
    expect(buttons[1]!.props['aria-pressed']).toBe(true);
    act(() => buttons[0]!.props.onClick());
    act(() => buttons[2]!.props.onClick());
    expect(onDevice).toHaveBeenCalledWith('');
    expect(onPort).toHaveBeenCalledWith(5173);
    act(() => renderer.unmount());
  });

  it('announces port errors and loading states', () => {
    const renderer = create(<PortsPanel id="ports" state={{ ...portState, error: 'Unavailable' }} onDevice={vi.fn()} onPort={vi.fn()} />);
    expect(renderer.root.findByProps({ role: 'alert' }).children).toEqual(['Unavailable']);
    act(() => renderer.update(<PortsPanel id="ports" state={{ ...portState, ports: null }} onDevice={vi.fn()} onPort={vi.fn()} />));
    expect(renderer.root.findAllByProps({ role: 'status' }).some((node) => node.children.includes('Loading…'))).toBe(true);
    act(() => renderer.unmount());
  });

  it('announces navigation errors and gives the refusal escape action an accessible name', () => {
    const tab = { ...createBrowserTab('preview'), rejected: 'Not previewable' };
    const renderer = create(<BrowserNotice tab={tab} url={null} />);
    expect(renderer.root.findByProps({ role: 'alert' }).children).toEqual(['Not previewable']);
    act(() => renderer.update(<BrowserNotice tab={{ ...tab, refused: true }} url="https://example.org/" />));
    expect(renderer.root.findByProps({ role: 'status' })).toBeDefined();
    expect(renderer.root.findByType('button').props['aria-label']).toBe('Open in system browser');
    act(() => renderer.unmount());
  });
});
