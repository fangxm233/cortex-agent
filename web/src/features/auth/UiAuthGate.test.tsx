import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { LangProvider } from '@/i18n';
import { UiAuthGate } from './UiAuthGate';

const probe = vi.hoisted(() => vi.fn());
const login = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ui-session', () => ({
  probeUiSession: probe,
  uiLogin: login,
  uiLogout: vi.fn(),
}));

const CHILD = 'THE-APP';

function render(): ReactTestRenderer {
  let r!: ReactTestRenderer;
  act(() => {
    r = create(
      <LangProvider>
        <UiAuthGate><span>{CHILD}</span></UiAuthGate>
      </LangProvider>,
    );
  });
  return r;
}

/** Let the probe promise and the state update it triggers settle. */
async function settle(r: ReactTestRenderer): Promise<void> {
  await act(async () => { await Promise.resolve(); });
  r.update(
    <LangProvider>
      <UiAuthGate><span>{CHILD}</span></UiAuthGate>
    </LangProvider>,
  );
}

const text = (r: ReactTestRenderer): string => JSON.stringify(r.toJSON() ?? '');

beforeEach(() => {
  probe.mockReset();
  login.mockReset();
  delete (globalThis as { __CORTEX_DESKTOP__?: boolean }).__CORTEX_DESKTOP__;
  delete (globalThis as { __CORTEX_DESKTOP_CONFIG?: unknown }).__CORTEX_DESKTOP_CONFIG;
});
afterEach(() => vi.unstubAllGlobals());

describe('UiAuthGate', () => {
  it('renders nothing while the one probe is in flight, then the app once authenticated', async () => {
    probe.mockResolvedValue({ authenticated: true, tokenLogin: true });
    const r = render();
    expect(r.toJSON()).toBeNull(); // no flash of a login form before we know
    await settle(r);
    expect(text(r)).toContain(CHILD);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('shows the token form when the server says "not in, but you may log in"', async () => {
    probe.mockResolvedValue({ authenticated: false, tokenLogin: true });
    const r = render();
    await settle(r);
    expect(text(r)).not.toContain(CHILD);
    expect(r.root.findAllByType('input').length).toBe(1);
  });

  it('accepts a token, re-probes, and only then mounts the app', async () => {
    probe.mockResolvedValueOnce({ authenticated: false, tokenLogin: true });
    login.mockResolvedValue({ ok: true });
    probe.mockResolvedValueOnce({ authenticated: true, tokenLogin: true });
    const r = render();
    await settle(r);

    const input = r.root.findByType('input');
    await act(async () => { input.props.onChange({ target: { value: 'the-token' } }); });
    await act(async () => { await r.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
    await settle(r);

    expect(login).toHaveBeenCalledWith('the-token');
    expect(text(r)).toContain(CHILD);
  });

  it('keeps the form up and says so when the token is refused', async () => {
    probe.mockResolvedValue({ authenticated: false, tokenLogin: true });
    login.mockResolvedValue({ ok: false, status: 401 });
    const r = render();
    await settle(r);

    const input = r.root.findByType('input');
    await act(async () => { input.props.onChange({ target: { value: 'wrong' } }); });
    await act(async () => { await r.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
    await settle(r);

    expect(text(r)).not.toContain(CHILD);
  });

  it('explains instead of offering a useless form when token login is off', async () => {
    probe.mockResolvedValue({ authenticated: false, tokenLogin: false });
    const r = render();
    await settle(r);
    expect(r.root.findAllByType('input').length).toBe(0);
  });

  it('never probes inside a native shell — it already holds the token', async () => {
    (globalThis as { __CORTEX_DESKTOP__?: boolean }).__CORTEX_DESKTOP__ = true;
    const r = render();
    expect(text(r)).toContain(CHILD);
    expect(probe).not.toHaveBeenCalled();
  });
});
