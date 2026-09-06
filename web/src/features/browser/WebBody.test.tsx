// input:  WebBody actions over one owned tab, plus forward mocks
// output: navigation, frame identity and port provenance regressions
// pos:    Focused component tests for a single web tab body
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useCallback, useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/theme';
import { WebBody } from './WebBody';
import { createBrowserTab, type BrowserTabState } from './browser-target';

const forwardMocks = vi.hoisted(() => ({
  listForwardDevices: vi.fn(),
  listRemotePorts: vi.fn(),
  listDeviceRemotePorts: vi.fn(),
  openDeviceForward: vi.fn(),
  startForward: vi.fn(),
}));

vi.mock('./forward', async (importOriginal) => ({
  ...await importOriginal<typeof import('./forward')>(),
  canForward: () => true,
  ...forwardMocks,
}));

/** The dock owns a web tab's state; this stands in for it so the body can be driven alone. */
function Harness(): JSX.Element {
  const [tab, setTab] = useState<BrowserTabState>(() => createBrowserTab('browser-tab-0'));
  const onUpdate = useCallback((update: (entry: BrowserTabState) => BrowserTabState) => {
    setTab((entry) => update(entry));
  }, []);
  return <ThemeProvider><WebBody tab={tab} active onUpdate={onUpdate} /></ThemeProvider>;
}

function input(renderer: ReactTestRenderer) {
  return renderer.root.findByType('input');
}

function navigate(renderer: ReactTestRenderer, url: string): void {
  act(() => input(renderer).props.onChange({ target: { value: url } }));
  act(() => input(renderer).props.onKeyDown({ key: 'Enter' }));
}

function nodeText(node: ReactTestRenderer['root']): string {
  return node.children.map((child) => typeof child === 'string' ? child : nodeText(child)).join('');
}

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  vi.clearAllMocks();
  forwardMocks.listForwardDevices.mockResolvedValue([]);
  forwardMocks.listRemotePorts.mockResolvedValue([]);
  forwardMocks.listDeviceRemotePorts.mockResolvedValue([]);
});

describe('WebBody', () => {
  it('shows the address bar until the tab has navigated', () => {
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<Harness />); });
    expect(renderer.root.findAllByType('iframe')).toHaveLength(0);
    navigate(renderer, 'http://127.0.0.1:5173/');
    expect(renderer.root.findByProps({ 'data-browser-frame': 'browser-tab-0' }).props.src).toBe('http://127.0.0.1:5173/');
  });

  it('replaces the frame identity when the tab navigates to a new document', () => {
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<Harness />); });
    navigate(renderer, 'http://127.0.0.1:5173/');
    const firstFrame = renderer.root.findByProps({ 'data-browser-frame': 'browser-tab-0' });
    navigate(renderer, 'http://127.0.0.1:3000/');
    expect(renderer.root.findByProps({ 'data-browser-frame': 'browser-tab-0' })).not.toBe(firstFrame);
  });

  it('refuses an address that is not previewable, without navigating', () => {
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<Harness />); });
    navigate(renderer, 'javascript:alert(1)');
    expect(renderer.root.findAllByType('iframe')).toHaveLength(0);
  });

  it('forwards a server port without waiting for a device mapping', async () => {
    forwardMocks.listRemotePorts.mockResolvedValue([{ port: 5173, address: '127.0.0.1', process: 'vite' }]);
    forwardMocks.startForward.mockResolvedValue({ remotePort: 5173, localPort: 5174, url: 'http://127.0.0.1:5174/' });

    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<Harness />); });
    act(() => renderer.root.findByProps({ title: 'Ports listening on the server or a connected device' }).props.onClick());
    await settle();
    const portButton = renderer.root.findAllByType('button').find((node) => nodeText(node).startsWith('5173'));
    act(() => portButton!.props.onClick());
    await settle();

    expect(forwardMocks.startForward).toHaveBeenCalledWith(5173);
    expect(input(renderer).props.value).toBe('http://127.0.0.1:5174/');
    expect(renderer.root.findByProps({ 'data-forward-origin': 'server:5173' })).toBeTruthy();
  });

  it('keeps the original device port visible while opening its mapped URL', async () => {
    let resolveMapping!: (value: { device: string; remoteHost: string; remotePort: number; localPort: number }) => void;
    forwardMocks.listForwardDevices.mockResolvedValue([{ device: 'my-pc', platform: 'win32' }]);
    forwardMocks.listDeviceRemotePorts.mockResolvedValue([{ port: 6006, address: '127.0.0.1', process: 'vite' }]);
    forwardMocks.openDeviceForward.mockReturnValue(new Promise((resolve) => { resolveMapping = resolve; }));
    forwardMocks.startForward.mockResolvedValue({ remotePort: 41234, localPort: 41235, url: 'http://127.0.0.1:41235/' });

    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<Harness />); });
    act(() => renderer.root.findByProps({ title: 'Ports listening on the server or a connected device' }).props.onClick());
    await settle();
    const deviceButton = renderer.root.findAllByType('button').find((node) => nodeText(node) === 'my-pc');
    act(() => deviceButton!.props.onClick());
    await settle();
    const portButton = renderer.root.findAllByType('button').find((node) => nodeText(node).startsWith('6006'));
    act(() => portButton!.props.onClick());

    expect(renderer.root.findByProps({ 'data-forward-origin': 'my-pc:6006' })).toBeTruthy();
    await act(async () => {
      resolveMapping({ device: 'my-pc', remoteHost: '127.0.0.1', remotePort: 6006, localPort: 41234 });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(forwardMocks.startForward).toHaveBeenCalledWith(41234);
    expect(input(renderer).props.value).toBe('http://127.0.0.1:41235/');
    expect(renderer.root.findByProps({ 'data-forward-origin': 'my-pc:6006' })).toBeTruthy();
  });

  it('ignores an older forward that finishes after a newer operation', async () => {
    const resolvers: Array<(value: { device: string; remoteHost: string; remotePort: number; localPort: number }) => void> = [];
    forwardMocks.listForwardDevices.mockResolvedValue([{ device: 'my-pc', platform: 'win32' }]);
    forwardMocks.listDeviceRemotePorts.mockResolvedValue([{ port: 6006, address: '127.0.0.1', process: 'vite' }]);
    forwardMocks.openDeviceForward.mockImplementation(() => new Promise((resolve) => { resolvers.push(resolve); }));
    forwardMocks.startForward.mockImplementation(async (port: number) => ({
      remotePort: port,
      localPort: port + 1,
      url: `http://127.0.0.1:${port + 1}/`,
    }));

    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<Harness />); });
    const openPicker = async (): Promise<void> => {
      act(() => renderer.root.findByProps({ title: 'Ports listening on the server or a connected device' }).props.onClick());
      await settle();
      const device = renderer.root.findAllByType('button').find((node) => nodeText(node) === 'my-pc');
      if (device) {
        act(() => device.props.onClick());
        await settle();
      }
      const port = renderer.root.findAllByType('button').find((node) => nodeText(node).startsWith('6006'));
      act(() => port!.props.onClick());
    };

    await openPicker();
    await openPicker();
    await act(async () => {
      resolvers[1]!({ device: 'my-pc', remoteHost: '127.0.0.1', remotePort: 6006, localPort: 42000 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(input(renderer).props.value).toBe('http://127.0.0.1:42001/');

    await act(async () => {
      resolvers[0]!({ device: 'my-pc', remoteHost: '127.0.0.1', remotePort: 6006, localPort: 41000 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(input(renderer).props.value).toBe('http://127.0.0.1:42001/');
    expect(forwardMocks.startForward).not.toHaveBeenCalledWith(41000);
  });
});
