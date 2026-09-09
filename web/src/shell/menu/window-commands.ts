// input:  native window commands and platform identity
// output: serialized fullscreen transitions and checked native calls
// pos:    Window transitions that preserve pre-fullscreen state
// >>> Once updated, update this header and parent CORTEX.md <<<
import { safeInvoke, type NativeInvokeResult } from '@/lib/native-bridge';
import type { DesktopPlatform } from '@/lib/desktop-platform';

const LABEL = { label: 'main' };
type Flag = 'is_fullscreen' | 'is_maximized';

export function checked<T>(result: NativeInvokeResult<T>): T {
  if (!result.ok) throw new Error('native_window_action_failed');
  return result.value;
}

async function flag(name: Flag): Promise<boolean> {
  return checked(await safeInvoke(`plugin:window|${name}`, LABEL));
}

async function settled(name: Flag, target: boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await flag(name) === target) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('native_window_transition_timed_out');
}

async function fullscreen(value: boolean): Promise<void> {
  checked(await safeInvoke('plugin:window|set_fullscreen', { ...LABEL, value }));
  await settled('is_fullscreen', value);
}

async function maximize(value: boolean): Promise<void> {
  const command = value ? 'plugin:window|maximize' : 'plugin:window|unmaximize';
  checked(await safeInvoke(command, LABEL));
  await settled('is_maximized', value);
}

/** Tao's Windows borderless NCCALCSIZE uses rcWork while IsZoomed is true,
 * even in fullscreen. Unmaximize first so the client fills the monitor, not
 * just its taskbar work area. Restore that state after leaving fullscreen. */
export function createFullscreenController(platform: DesktopPlatform | null) {
  let busy = false;
  let restoreMaximized = false;

  async function enter(): Promise<void> {
    restoreMaximized = platform === 'windows' && await flag('is_maximized');
    if (restoreMaximized) await maximize(false);
    try {
      await fullscreen(true);
    } catch (error) {
      await fullscreen(false).catch(() => {});
      if (restoreMaximized) await maximize(true).catch(() => {});
      throw error;
    }
  }

  async function leave(): Promise<void> {
    await fullscreen(false);
    if (restoreMaximized) await maximize(true);
    restoreMaximized = false;
  }

  async function transition(exitOnly = false): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const current = await flag('is_fullscreen');
      if (current) await leave();
      else if (!exitOnly) await enter();
    } finally {
      busy = false;
    }
  }

  return { toggle: () => transition(), exit: () => transition(true) };
}
