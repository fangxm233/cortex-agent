// input:  WebBody actions, Motion, frame tree and forward mocks
// output: tab identity, lifetime and port provenance regressions
// pos:    Focused component tests for the browser workspace
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Reorder } from 'motion/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/theme';
import { WebBody } from './WebBody';
import { webItem } from './browser-target';

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

function workspace(): JSX.Element {
  return <ThemeProvider><WebBody item={webItem('')} /></ThemeProvider>;
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

describe('WebBody tabs', () => {
  it('keeps inactive iframe elements mounted until their tab closes', () => {
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(workspace()); });

    navigate(renderer, 'http://127.0.0.1:5173/');
    const firstFrame = renderer.root.findByProps({ 'data-browser-frame': 'browser-tab-0' });

    act(() => renderer.root.findByProps({ 'data-add-tab': '' }).props.onClick());
    expect(renderer.root.findAllByType('iframe')).toHaveLength(1);
    expect(renderer.root.findByProps({ 'data-browser-tab-body': 'browser-tab-0' }).props.style.display).toBe('none');

    navigate(renderer, 'http://127.0.0.1:3000/');
    expect(renderer.root.findAllByType('iframe')).toHaveLength(2);
    act(() => renderer.root.findByProps({ 'data-browser-tab': 'browser-tab-0' }).props.onClick());
    expect(renderer.root.findByProps({ 'data-browser-frame': 'browser-tab-0' })).toBe(firstFrame);
    expect(renderer.root.findByProps({ 'data-browser-tab-body': 'browser-tab-1' }).props.style.display).toBe('none');

    act(() => renderer.root.findByProps({ 'data-close-tab': 'browser-tab-0' }).props.onClick());
    expect(renderer.root.findAllByType('iframe')).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-browser-frame': 'browser-tab-0' })).toHaveLength(0);
    const exitingClose = renderer.root.findAllByProps({ 'data-close-tab': 'browser-tab-0' });
    expect(exitingClose).toHaveLength(1);
    expect(exitingClose[0].props.disabled).toBe(true);
  });

  it('reorders tab chrome without moving live iframe bodies', () => {
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(workspace()); });
    navigate(renderer, 'http://127.0.0.1:5173/');
    act(() => renderer.root.findByProps({ 'data-add-tab': '' }).props.onClick());
    navigate(renderer, 'http://127.0.0.1:3000/');
    const firstFrame = renderer.root.findByProps({ 'data-browser-frame': 'browser-tab-0' });
    const secondFrame = renderer.root.findByProps({ 'data-browser-frame': 'browser-tab-1' });

    act(() => renderer.root.findByType(Reorder.Group).props.onReorder(['browser-tab-1', 'browser-tab-0']));

    const tabIds = renderer.root.findAll((node) => node.props['data-browser-tab'] !== undefined)
      .map((node) => node.props['data-browser-tab']);
    const bodyIds = renderer.root.findAll((node) => node.props['data-browser-tab-body'] !== undefined)
      .map((node) => node.props['data-browser-tab-body']);
    expect(tabIds).toEqual(['browser-tab-1', 'browser-tab-0']);
    expect(bodyIds).toEqual(['browser-tab-0', 'browser-tab-1']);
    expect(renderer.root.findByProps({ 'data-browser-frame': 'browser-tab-0' })).toBe(firstFrame);
    expect(renderer.root.findByProps({ 'data-browser-frame': 'browser-tab-1' })).toBe(secondFrame);
  });

  it('replaces a frame identity when a tab navigates to a new document', () => {
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(workspace()); });
    navigate(renderer, 'http://127.0.0.1:5173/');
    const firstFrame = renderer.root.findByProps({ 'data-browser-frame': 'browser-tab-0' });
    navigate(renderer, 'http://127.0.0.1:3000/');
    expect(renderer.root.findByProps({ 'data-browser-frame': 'browser-tab-0' })).not.toBe(firstFrame);
  });

  it('keeps address drafts and viewport choices independent per tab', () => {
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(workspace()); });
    act(() => input(renderer).props.onChange({ target: { value: 'draft-a' } }));
    act(() => renderer.root.findByType('select').props.onChange({ target: { value: 'phone' } }));
    act(() => renderer.root.findByProps({ 'data-add-tab': '' }).props.onClick());
    act(() => input(renderer).props.onChange({ target: { value: 'draft-b' } }));
    act(() => renderer.root.findByType('select').props.onChange({ target: { value: 'desktop' } }));

    act(() => renderer.root.findByProps({ 'data-browser-tab': 'browser-tab-0' }).props.onClick());
    expect(input(renderer).props.value).toBe('draft-a');
    expect(renderer.root.findByType('select').props.value).toBe('phone');
    act(() => renderer.root.findByProps({ 'data-browser-tab': 'browser-tab-1' }).props.onClick());
    expect(input(renderer).props.value).toBe('draft-b');
    expect(renderer.root.findByType('select').props.value).toBe('desktop');
  });

  it('forwards a server port without waiting for a device mapping', async () => {
    forwardMocks.listRemotePorts.mockResolvedValue([{ port: 5173, address: '127.0.0.1', process: 'vite' }]);
    forwardMocks.startForward.mockResolvedValue({ remotePort: 5173, localPort: 5174, url: 'http://127.0.0.1:5174/' });

    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(workspace()); });
    act(() => renderer.root.findByProps({ title: 'Ports listening on the server or a connected device' }).props.onClick());
    await settle();
    const portButton = renderer.root.findAllByType('button').find((node) => nodeText(node).startsWith('5173'));
    act(() => portButton!.props.onClick());
    await settle();

    expect(forwardMocks.startForward).toHaveBeenCalledWith(5173);
    expect(input(renderer).props.value).toBe('http://127.0.0.1:5174/');
    expect(renderer.root.findByProps({ 'data-forward-source': 'server:5173' })).toBeTruthy();
  });

  it('keeps the original device port visible while opening its mapped URL', async () => {
    let resolveMapping!: (value: { device: string; remoteHost: string; remotePort: number; localPort: number }) => void;
    forwardMocks.listForwardDevices.mockResolvedValue([{ device: 'my-pc', platform: 'win32' }]);
    forwardMocks.listDeviceRemotePorts.mockResolvedValue([{ port: 6006, address: '127.0.0.1', process: 'vite' }]);
    forwardMocks.openDeviceForward.mockReturnValue(new Promise((resolve) => { resolveMapping = resolve; }));
    forwardMocks.startForward.mockResolvedValue({ remotePort: 41234, localPort: 41235, url: 'http://127.0.0.1:41235/' });

    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(workspace()); });
    act(() => renderer.root.findByProps({ title: 'Ports listening on the server or a connected device' }).props.onClick());
    await settle();
    const deviceButton = renderer.root.findAllByType('button').find((node) => nodeText(node) === 'my-pc');
    act(() => deviceButton!.props.onClick());
    await settle();
    const portButton = renderer.root.findAllByType('button').find((node) => nodeText(node).startsWith('6006'));
    act(() => portButton!.props.onClick());

    expect(renderer.root.findByProps({ 'data-forward-source': 'my-pc:6006' })).toBeTruthy();
    await act(async () => {
      resolveMapping({ device: 'my-pc', remoteHost: '127.0.0.1', remotePort: 6006, localPort: 41234 });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(forwardMocks.startForward).toHaveBeenCalledWith(41234);
    expect(input(renderer).props.value).toBe('http://127.0.0.1:41235/');
    expect(renderer.root.findByProps({ 'data-forward-source': 'my-pc:6006' })).toBeTruthy();
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
    act(() => { renderer = create(workspace()); });
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
      resolvers[1]({ device: 'my-pc', remoteHost: '127.0.0.1', remotePort: 6006, localPort: 42000 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(input(renderer).props.value).toBe('http://127.0.0.1:42001/');

    await act(async () => {
      resolvers[0]({ device: 'my-pc', remoteHost: '127.0.0.1', remotePort: 6006, localPort: 41000 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(input(renderer).props.value).toBe('http://127.0.0.1:42001/');
    expect(forwardMocks.startForward).not.toHaveBeenCalledWith(41000);
  });
});
