// input:  setup header, language/theme and window action doubles
// output: appearance controls and native caption regression tests
// pos:    Provider onboarding chrome behavior checks
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { en } from '@/i18n/vocab';
import { SetupHeader } from './SetupHeader';

const actions = vi.hoisted(() => ({ setLang: vi.fn(), toggleTheme: vi.fn(), close: vi.fn() }));
vi.mock('@/i18n', () => ({ useVocab: () => en, useLang: () => 'en', useSetLang: () => actions.setLang }));
vi.mock('@/theme', () => ({ useToggleTheme: () => actions.toggleTheme }));
vi.mock('@/shell/menu/useWindowActions', () => ({ useWindowActions: () => ({ close: actions.close }) }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('keeps the installation header language and appearance controls', () => {
  const view = create(<SetupHeader />);
  expect(view.root.findByProps({ 'data-tauri-drag-region': 'deep' })).toBeTruthy();
  const group = view.root.findByProps({ 'aria-label': en.setupLanguage });
  expect(group.findAllByType('button')[0].props['aria-pressed']).toBe(true);
  act(() => group.findAllByType('button')[1].props.onClick());
  act(() => view.root.findByProps({ 'aria-label': en.setupToggleTheme }).props.onClick());
  expect(actions.setLang).toHaveBeenCalledWith('zh');
  expect(actions.toggleTheme).toHaveBeenCalledOnce();
  expect(view.root.findAllByProps({ 'aria-label': en.winClose })).toHaveLength(0);
  view.unmount();
});
it('keeps close controls in a frameless native window', () => {
  vi.stubGlobal('__CORTEX_TITLEBAR__', 'custom');
  const view = create(<SetupHeader />);
  act(() => view.root.findByProps({ 'aria-label': en.winClose }).props.onClick());
  expect(actions.close).toHaveBeenCalledOnce();
  view.unmount();
});
