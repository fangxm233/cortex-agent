import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const h = vi.hoisted(() => ({ native: true, invoke: vi.fn() }));
vi.mock('@/lib/desktop-config', () => ({ isNativeShell: () => h.native }));
vi.mock('@/lib/native-bridge', () => ({ safeInvoke: h.invoke }));

import { AppUpdateCard } from './AppUpdateCard';
import { LangProvider, useSetLang } from '@/i18n';

const PREFS = { silent: true, failedAttempts: 0 };

/** get_update_prefs answers `prefs`; set_update_silent answers the stored result of the edit. */
function shellWith(prefs: Record<string, unknown>) {
  let stored = prefs;
  h.invoke.mockImplementation(async (command: string, args?: { silent: boolean }) => {
    if (command === 'set_update_silent') {
      stored = { ...stored, silent: args!.silent, ...(args!.silent ? { failedAttempts: 0 } : {}) };
    }
    return { ok: true, value: stored };
  });
}

function TextHarness({ children }: { children: ReactNode }) {
  const setLang = useSetLang();
  return (
    <>
      <button type="button" data-lang="en" onClick={() => setLang('en')}>en</button>
      <button type="button" data-lang="zh" onClick={() => setLang('zh')}>zh</button>
      {children}
    </>
  );
}

function textOf(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && 'children' in node) return textOf((node as { children?: unknown }).children);
  return '';
}

function allText(renderer: ReactTestRenderer): string {
  return textOf(renderer.toJSON());
}

async function render(children: ReactNode = <AppUpdateCard />): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<LangProvider>{children}</LangProvider>); });
  return renderer;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.native = true;
  shellWith(PREFS);
});

describe('silent app update switch', () => {
  it('renders nothing off-shell and never asks the bridge', async () => {
    h.native = false;

    const renderer = await render();

    expect(renderer.toJSON()).toBeNull();
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('stays hidden on a shell without the update-prefs commands', async () => {
    h.invoke.mockResolvedValue({ ok: false, reason: 'unavailable' });

    const renderer = await render();

    expect(renderer.toJSON()).toBeNull();
  });

  it('writes the new value through set_update_silent and follows what was persisted', async () => {
    const renderer = await render();
    expect(renderer.root.findByProps({ role: 'switch' }).props['aria-checked']).toBe(true);

    await act(async () => renderer.root.findByProps({ role: 'switch' }).props.onClick());

    expect(h.invoke).toHaveBeenLastCalledWith('set_update_silent', { silent: false });
    expect(renderer.root.findByProps({ role: 'switch' }).props['aria-checked']).toBe(false);
  });

  it('keeps the switch where it was when the shell refuses the write', async () => {
    const renderer = await render();
    h.invoke.mockResolvedValue({ ok: false, reason: 'failed', error: 'disk full' });

    await act(async () => renderer.root.findByProps({ role: 'switch' }).props.onClick());

    expect(renderer.root.findByProps({ role: 'switch' }).props['aria-checked']).toBe(true);
    expect(renderer.root.findByProps({ role: 'alert' }).children.length).toBeGreaterThan(0);
  });

  it('says the shell is already asking after three failed silent installs, and can retry', async () => {
    shellWith({ silent: true, failedAttempts: 3 });

    const renderer = await render();
    // The switch still reports the stored preference; the copy must not claim it is working.
    expect(renderer.root.findByProps({ role: 'switch' }).props['aria-checked']).toBe(true);

    await act(async () => renderer.root.findByProps({ 'data-app-update-retry': '' }).props.onClick());

    expect(h.invoke).toHaveBeenLastCalledWith('set_update_silent', { silent: true });
    expect(renderer.root.findAllByProps({ 'data-app-update-retry': '' })).toHaveLength(0);
  });

  it('localizes the switch aria label and fallback explanation through the live language switch', async () => {
    shellWith({ silent: true, failedAttempts: 3, lastInstalledVersion: '2026.9.20' });

    const renderer = await render(<TextHarness><AppUpdateCard /></TextHarness>);

    await act(async () => renderer.root.findByProps({ 'data-lang': 'en' }).props.onClick());

    expect(renderer.root.findByProps({ role: 'switch' }).props['aria-label']).toBe('Install updates automatically');
    expect(allText(renderer)).toContain('Automatic installation failed; confirmation is now required.');
    expect(allText(renderer)).toContain('Retry automatic installation');
    expect(allText(renderer)).toContain('Last updated to 2026.9.20');

    await act(async () => renderer.root.findByProps({ 'data-lang': 'zh' }).props.onClick());

    expect(renderer.root.findByProps({ role: 'switch' }).props['aria-label']).toBe('自动安装更新');
    expect(allText(renderer)).toContain('自动安装失败，已改为安装前询问。');
    expect(allText(renderer)).toContain('重试自动安装');
    expect(allText(renderer)).toContain('上次更新到 2026.9.20');
  });
});
