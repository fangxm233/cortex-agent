import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockIntakeProvider, type DockIntakeValue } from '@/design/dock-intake';
import type { DocItem } from './preview-item';
import { usePreviewHost, usePreviewModalChrome, type PreviewHost } from './preview-modal';

const DOC: DocItem = { kind: 'text', name: 'a.md', path: 'workspace/a.md' };

function dockValue(over: Partial<DockIntakeValue>): DockIntakeValue {
  return { canDock: false, active: false, activeKind: null, openFile: vi.fn(), openWeb: vi.fn(), ...over };
}

function renderHost(dock?: DockIntakeValue): { host: () => PreviewHost<DocItem> } {
  let current!: PreviewHost<DocItem>;
  function Probe(): null {
    current = usePreviewHost<DocItem>();
    return null;
  }
  act(() => { create(dock ? <DockIntakeProvider value={dock}><Probe /></DockIntakeProvider> : <Probe />); });
  return { host: () => current };
}

describe('usePreviewHost', () => {
  it('opens and closes the modal when there is no dock', () => {
    const { host } = renderHost();
    expect(host().pin).toBeUndefined();

    act(() => host().open(DOC));
    expect(host().item).toBe(DOC);
    act(() => host().close());
    expect(host().item).toBeNull();
  });

  it('opens a dock tab instead of the modal while the dock is open', () => {
    const dock = dockValue({ canDock: true, active: true });
    const { host } = renderHost(dock);

    act(() => host().open(DOC));

    expect(dock.openFile).toHaveBeenCalledWith(DOC);
    expect(host().item).toBeNull();
  });

  it('pins the open item into the dock and dismisses the modal', () => {
    const dock = dockValue({ canDock: true });
    const { host } = renderHost(dock);
    act(() => host().open(DOC));

    act(() => host().pin?.());

    expect(dock.openFile).toHaveBeenCalledWith(DOC);
    expect(host().item).toBeNull();
  });
});

describe('usePreviewModalChrome', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function stubPage(): { target: EventTarget; body: { style: { overflow: string } } } {
    const target = new EventTarget();
    const history = { state: null as unknown, pushState(state: unknown) { history.state = state; }, back: vi.fn() };
    const body = { style: { overflow: 'auto' } };
    vi.stubGlobal('window', {
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      history,
    });
    vi.stubGlobal('document', { body });
    return { target, body };
  }

  it('closes on Escape and locks page scroll only while mounted', () => {
    const { target, body } = stubPage();
    const onClose = vi.fn();
    function Modal(): null {
      usePreviewModalChrome(onClose);
      return null;
    }

    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<Modal />); });
    expect(body.style.overflow).toBe('hidden');
    target.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Enter' }));
    target.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => renderer.unmount());
    expect(body.style.overflow).toBe('auto');
    target.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a back navigation instead of leaving the page', () => {
    const { target } = stubPage();
    const onClose = vi.fn();
    function Modal(): null {
      usePreviewModalChrome(onClose);
      return null;
    }
    act(() => { create(<Modal />); });

    target.dispatchEvent(new Event('popstate'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
