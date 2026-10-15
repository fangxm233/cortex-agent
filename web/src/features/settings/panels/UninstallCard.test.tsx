import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { en } from '@/i18n/vocab';
import { UninstallCard } from './UninstallCard';
vi.mock('@/i18n', () => ({ useVocab: () => en }));
afterEach(() => { vi.unstubAllGlobals(); });

const text = (view: ReactTestRenderer) => JSON.stringify(view.toJSON());

it('offers the settings entry only on a desktop shell that has the uninstaller', async () => {
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<UninstallCard />); });
  expect(view.toJSON()).toBeNull();
  const invoke = vi.fn(async (command: string) => (command === 'uninstall_info' ? { localServer: false } : null));
  vi.stubGlobal('__CORTEX_DESKTOP__', true);
  vi.stubGlobal('__TAURI__', { core: { invoke } });
  await act(async () => { view = create(<UninstallCard />); });
  expect(text(view)).toContain(en.uninstCardTitle);
  await act(async () => { view.root.findByProps({ 'data-uninstall-open': '' }).props.onClick(); });
  expect(invoke).toHaveBeenCalledWith('uninstall_open', undefined);
});
