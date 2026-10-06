import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DockProvider, useDock } from './DockProvider';
import type { WebDockTab } from './dock-tabs';

const closeDeviceForward = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/features/browser/forward', () => ({ closeDeviceForward }));

let dock: ReturnType<typeof useDock>;
function Probe(): null {
  dock = useDock();
  return null;
}

function mount(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<DockProvider><Probe /></DockProvider>); });
  return renderer;
}

function webTab(): WebDockTab {
  const tab = dock.state?.tabs.find((entry) => entry.kind === 'web');
  if (!tab || tab.kind !== 'web') throw new Error('no web tab');
  return tab;
}

function forwardTo(id: string, device: string, port: number): void {
  act(() => dock.updateWeb(id, (tab) => ({
    ...tab,
    forward: { status: 'ready', device, originalPort: port, targetUrl: `http://127.0.0.1:4${port}/` },
  })));
}

beforeEach(() => closeDeviceForward.mockClear());

describe('dock: device port mappings follow the tabs that show them', () => {
  it('closes the mapping when its tab closes', () => {
    mount();
    act(() => dock.openWeb());
    const { id } = webTab();
    forwardTo(id, 'desk', 6006);
    expect(closeDeviceForward).not.toHaveBeenCalled();
    act(() => dock.close(id));
    expect(closeDeviceForward).toHaveBeenCalledWith('desk', 6006);
  });

  it('closes the old mapping when the tab forwards somewhere else', () => {
    mount();
    act(() => dock.openWeb());
    const { id } = webTab();
    forwardTo(id, 'desk', 6006);
    forwardTo(id, 'desk', 8888);
    expect(closeDeviceForward).toHaveBeenCalledTimes(1);
    expect(closeDeviceForward).toHaveBeenCalledWith('desk', 6006);
  });

  it('does not close a mapping the tab is re-opening (picking the same port again)', () => {
    mount();
    act(() => dock.openWeb());
    const { id } = webTab();
    forwardTo(id, 'desk', 6006);
    act(() => dock.updateWeb(id, (tab) => ({
      ...tab,
      forward: { status: 'connecting', operationId: 2, device: 'desk', originalPort: 6006 },
    })));
    forwardTo(id, 'desk', 6006);
    expect(closeDeviceForward).not.toHaveBeenCalled();
  });

  it('keeps mappings while the dock is only hidden, and never closes server ports', () => {
    mount();
    act(() => dock.openWeb());
    const { id } = webTab();
    forwardTo(id, 'desk', 6006);
    act(() => dock.closeDock());
    expect(closeDeviceForward).not.toHaveBeenCalled();
    forwardTo(id, '', 5173);
    act(() => dock.close(id));
    expect(closeDeviceForward).toHaveBeenCalledTimes(1);
    expect(closeDeviceForward).toHaveBeenCalledWith('desk', 6006);
  });
});
