import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { ModalRegistryProvider, defineModal } from './modal-registry';

// The registry replaced nine one-modal providers, so the two properties those providers had for
// free are the ones asserted here: a modal only sees its own key, and a trigger does not re-render
// when the modal it opens opens.

const alpha = defineModal<{ id: string }>('test.alpha');
const beta = defineModal('test.beta');
const loose = defineModal('test.loose', { requireProvider: false });

let alphaHandle: ReturnType<typeof alpha.useModal>;
let betaHandle: ReturnType<typeof beta.useModal>;

const renders = { alphaHost: 0, betaHost: 0, trigger: 0 };

function AlphaHost(): null {
  renders.alphaHost += 1;
  alphaHandle = alpha.useModal();
  return null;
}

function BetaHost(): null {
  renders.betaHost += 1;
  betaHandle = beta.useModal();
  return null;
}

function Trigger(): null {
  renders.trigger += 1;
  alpha.useModalActions();
  return null;
}

function mount(): ReactTestRenderer {
  renders.alphaHost = 0;
  renders.betaHost = 0;
  renders.trigger = 0;
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <ModalRegistryProvider><AlphaHost /><BetaHost /><Trigger /></ModalRegistryProvider>,
    );
  });
  return renderer;
}

describe('modal registry', () => {
  it('carries a payload from the trigger to the host and back to closed', () => {
    mount();
    expect(alphaHandle.isOpen).toBe(false);
    expect(alphaHandle.payload).toBeUndefined();

    act(() => { alphaHandle.open({ id: 'task-7' }); });
    expect(alphaHandle.isOpen).toBe(true);
    expect(alphaHandle.payload).toEqual({ id: 'task-7' });

    act(() => { alphaHandle.close(); });
    expect(alphaHandle.isOpen).toBe(false);
    expect(alphaHandle.payload).toBeUndefined();
  });

  it('does not re-render another kind’s host, nor its own trigger', () => {
    mount();
    const before = { ...renders };
    act(() => { alphaHandle.open({ id: 'task-7' }); });
    expect(renders.alphaHost).toBe(before.alphaHost + 1);
    expect(renders.betaHost).toBe(before.betaHost);
    expect(renders.trigger).toBe(before.trigger);
  });

  it('treats re-opening with the same payload as a no-op', () => {
    mount();
    act(() => { betaHandle.open(); });
    const after = renders.betaHost;
    act(() => { betaHandle.open(); });
    expect(renders.betaHost).toBe(after);
    expect(betaHandle.isOpen).toBe(true);
  });

  it('throws without a provider, unless the key opted out', () => {
    function Strict(): null { beta.useModal(); return null; }
    function Loose(): null { looseHandle = loose.useModal(); return null; }
    let looseHandle: ReturnType<typeof loose.useModal>;

    // React logs the caught render error itself; the assertion is the throw, not the noise.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => act(() => { create(<Strict />); })).toThrow(/ModalRegistryProvider/);
    quiet.mockRestore();
    act(() => { create(<Loose />); });
    expect(looseHandle!.isOpen).toBe(false);
    act(() => { looseHandle!.open(); });
    expect(looseHandle!.isOpen).toBe(false);
  });
});
