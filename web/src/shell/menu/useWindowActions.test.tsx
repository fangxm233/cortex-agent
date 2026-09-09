// input:  window hook, deterministic native calls and key events
// output: full screen, Escape and visible devtools failure tests
// pos:    Observable window actions regression checks
// >>> Once updated, update this header and parent CORTEX.md <<<
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { en } from '@/i18n/vocab';
import { useWindowActions } from './useWindowActions';
const toast = { toast: vi.fn(), dismiss: vi.fn() };
vi.mock('@/design/Toast', () => ({ useToastOptional: () => toast }));
vi.mock('@/i18n', () => ({ useVocab: () => en }));
let full: boolean;
let actions: ReturnType<typeof useWindowActions>;
let renderer: ReactTestRenderer;
let target: EventTarget;
const documentStub = { querySelector: vi.fn(() => null as unknown) };
const invoke = vi.fn(async (command: string, args?: { value?: boolean }) => {
  if (command.endsWith('|is_fullscreen')) return full;
  if (command.endsWith('|is_maximized')) return false;
  if (command.endsWith('|set_fullscreen')) full = args!.value!;
});
function Probe() { actions = useWindowActions(); return null; }
function escape(repeat = false, prevented = false) {
  const event = new Event('keydown', { cancelable: true });
  Object.assign(event, { key: 'Escape', repeat });
  if (prevented) event.preventDefault();
  target.dispatchEvent(event);
  return event;
}
beforeEach(async () => {
  full = false;
  target = new EventTarget();
  Object.assign(target, { localStorage: { getItem: () => null, setItem: vi.fn() } });
  vi.stubGlobal('window', target);
  vi.stubGlobal('document', documentStub);
  vi.stubGlobal('__CORTEX_PLATFORM__', 'windows');
  vi.stubGlobal('__TAURI__', { core: { invoke } });
  await act(async () => { renderer = create(<Probe />); });
});
afterEach(() => {
  act(() => renderer.unmount()); vi.unstubAllGlobals(); vi.clearAllMocks();
  documentStub.querySelector.mockReturnValue(null);
});
it('updates fullscreen state and exits with Escape', async () => {
  await act(async () => { actions.toggleFullscreen(); });
  expect(actions.isFullscreen).toBe(true);
  await act(async () => { expect(escape().defaultPrevented).toBe(true); });
  expect(actions.isFullscreen).toBe(false);
});
it('lets dialogs, prevented and repeated Escape keep their own semantics', async () => {
  await act(async () => { actions.toggleFullscreen(); });
  documentStub.querySelector.mockReturnValue({ role: 'dialog' });
  await act(async () => { escape(); });
  documentStub.querySelector.mockReturnValue(null);
  await act(async () => { escape(true); escape(false, true); });
  expect(full).toBe(true);
});
it('queries native state on focus changes, including OS fullscreen gestures', async () => {
  full = true;
  await act(async () => { target.dispatchEvent(new Event('focus')); });
  expect(actions.isFullscreen).toBe(true);
});
it('opens devtools through the supported native command', async () => {
  await act(async () => { actions.toggleDevTools(); });
  expect(invoke).toHaveBeenCalledWith('plugin:webview|internal_toggle_devtools', { label: 'main' });
  expect(toast.toast).not.toHaveBeenCalled();
});
it('shows a useful error for older shells without release devtools', async () => {
  invoke.mockRejectedValueOnce(new Error('Command not found'));
  await act(async () => { actions.toggleDevTools(); });
  expect(toast.toast).toHaveBeenCalledWith(expect.objectContaining({
    title: en.windowDevtoolsFailed, description: en.windowDevtoolsFailedHint, tone: 'failed',
  }));
});
it('reports fullscreen command errors without claiming successful state', async () => {
  invoke.mockRejectedValueOnce(new Error('denied'));
  await act(async () => { actions.toggleFullscreen(); });
  expect(actions.isFullscreen).toBe(false);
  expect(toast.toast).toHaveBeenCalledWith(expect.objectContaining({ title: en.windowActionFailed }));
});
