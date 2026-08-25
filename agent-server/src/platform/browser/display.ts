// input:  platform, environment, and probe results for graphical sessions
// output: the display a managed browser should use, and whether a human can take it over
// pos:    Managed-browser display resolution; the decision half is pure
// >>> If I am updated, update CORTEX.md <<<

import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { createLogger } from '@core/log.js';

const log = createLogger('browser-display');

/**
 * Where the managed browser draws (plan/embedded-browser.md §16).
 *
 * The display only decides whether a HUMAN can take over — the agent drives the browser over CDP,
 * which works identically headless. So an unavailable display is a capability degradation to be
 * reported, never a fatal error. Resolution is a probe, never an assumption: a hard-coded `:10`
 * is one machine's accident, and attaching to a display owned by ANOTHER user would paint our
 * browser onto their screen.
 */
export type DisplayMode = 'attached' | 'virtual' | 'headless';

export interface BrowserDisplay {
  mode: DisplayMode;
  /** X display string (`:10`) for linux attached/virtual; null where the platform has no such concept. */
  display: string | null;
  /** What to tell the user about taking over. */
  takeover: 'remote-desktop' | 'vnc-required' | 'none';
  /** Human-readable justification, surfaced in the UI. */
  reason: string;
}

export interface DisplayProbe {
  platform: NodeJS.Platform;
  /** Operator override (config/env). Trusted as-is. */
  override?: string;
  /** `$DISPLAY`, when set. */
  envDisplay?: string;
  /** `$WAYLAND_DISPLAY`, when set. */
  envWayland?: string;
  /** X displays owned by THIS uid that we actually connected to. */
  usableDisplays: string[];
  /** `Xvfb` is installed, so a virtual display can be created. */
  hasXvfb: boolean;
  /** macOS/Windows: this process lives in an interactive GUI session. */
  interactiveSession: boolean;
}

/**
 * Pure decision. Linux prefers a real session the user can already reach (RDP/VNC/console) over a
 * virtual one, because a virtual display needs an extra VNC bridge before anyone can see it.
 */
export function decideDisplay(p: DisplayProbe): BrowserDisplay {
  if (p.override) {
    return {
      mode: 'attached',
      display: p.override,
      takeover: 'remote-desktop',
      reason: `display pinned by configuration (${p.override})`,
    };
  }

  if (p.platform === 'linux') {
    // $DISPLAY only counts when the probe actually reached it — a stale variable is common in a
    // service environment, and pointing Chrome at a dead display fails at launch.
    if (p.envDisplay && p.usableDisplays.includes(p.envDisplay)) {
      return {
        mode: 'attached',
        display: p.envDisplay,
        takeover: 'remote-desktop',
        reason: `$DISPLAY ${p.envDisplay} is reachable`,
      };
    }
    if (p.usableDisplays.length > 0) {
      const display = p.usableDisplays[0];
      return {
        mode: 'attached',
        display,
        takeover: 'remote-desktop',
        reason: `graphical session ${display} belongs to this user and is reachable`,
      };
    }
    if (p.hasXvfb) {
      return {
        mode: 'virtual',
        display: null, // assigned when the virtual display is started
        takeover: 'vnc-required',
        reason: 'no reachable session; a virtual display will be created (a VNC bridge is needed to watch it)',
      };
    }
    return {
      mode: 'headless',
      display: null,
      takeover: 'none',
      reason: 'no graphical session and no Xvfb — the agent can browse, but nobody can take over',
    };
  }

  // macOS / Windows have no DISPLAY: a process either lives in an interactive session (window
  // appears, reachable by Screen Sharing / RDP) or it does not. Windows Session 0 isolation is the
  // trap: a service-hosted Chrome runs fine and CDP works, but the window can NEVER be seen, so it
  // must be reported as headless rather than promising a takeover that cannot happen.
  if (p.platform === 'darwin' || p.platform === 'win32') {
    return p.interactiveSession
      ? {
          mode: 'attached',
          display: null,
          takeover: 'remote-desktop',
          reason: 'running inside an interactive desktop session',
        }
      : {
          mode: 'headless',
          display: null,
          takeover: 'none',
          reason:
            p.platform === 'win32'
              ? 'service session (Session 0) cannot show a window — CDP still works, takeover cannot'
              : 'no Aqua session (daemon context) — CDP still works, takeover cannot',
        };
  }

  return { mode: 'headless', display: null, takeover: 'none', reason: `unsupported platform ${p.platform}` };
}

// ── Probes (impure) ───────────────────────────────────────────────────────────

/** X sockets owned by this uid AND actually connectable. Ownership alone is not enough: the socket
 *  may exist while XAUTHORITY denies us, and a display we cannot open would fail at launch. */
export function probeUsableDisplays(): string[] {
  let names: string[];
  try {
    names = fs.readdirSync('/tmp/.X11-unix');
  } catch {
    return [];
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const found: string[] = [];
  for (const name of names) {
    if (!/^X\d+$/.test(name)) continue;
    try {
      const st = fs.statSync(`/tmp/.X11-unix/${name}`);
      if (uid >= 0 && st.uid !== uid) continue; // never draw onto another user's screen
    } catch {
      continue;
    }
    const display = `:${name.slice(1)}`;
    if (canOpenDisplay(display)) found.push(display);
  }
  // Lowest display number first — deterministic, and the console/primary session sorts first.
  return found.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

function canOpenDisplay(display: string): boolean {
  const probes: Array<[string, string[]]> = [
    ['xdpyinfo', ['-display', display]],
    ['xset', ['-display', display, 'q']],
  ];
  for (const [bin, args] of probes) {
    try {
      execFileSync(bin, args, { stdio: 'ignore', timeout: 3000 });
      return true;
    } catch (e) {
      // ENOENT = the probe tool is missing; anything else = the display refused us.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
  }
  // Neither probe exists: fall back to "socket exists and is ours". Weaker, but refusing every
  // display on a machine without x11-utils would be worse.
  log.warn('neither xdpyinfo nor xset is installed — trusting X socket ownership');
  return true;
}

export function probeHasBinary(bin: string): boolean {
  try {
    execFileSync('which', [bin], { stdio: 'ignore', timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/** macOS: a GUI (Aqua) session. Windows: anything but the service session. */
export function probeInteractiveSession(platform: NodeJS.Platform, env = process.env): boolean {
  if (platform === 'darwin') {
    try {
      const out = execFileSync('launchctl', ['managername'], { encoding: 'utf8', timeout: 2000 });
      return out.trim() === 'Aqua';
    } catch {
      return false;
    }
  }
  if (platform === 'win32') {
    // Services run in SESSIONNAME=Services (Session 0); an interactive login is Console or RDP-Tcp#N.
    const session = env.SESSIONNAME;
    return !!session && session.toLowerCase() !== 'services';
  }
  return false;
}

/** Full resolution for this host. */
export function resolveBrowserDisplay(env = process.env): BrowserDisplay {
  const platform = process.platform;
  const probe: DisplayProbe = {
    platform,
    override: env.CORTEX_BROWSER_DISPLAY,
    envDisplay: env.DISPLAY,
    envWayland: env.WAYLAND_DISPLAY,
    usableDisplays: platform === 'linux' ? probeUsableDisplays() : [],
    hasXvfb: platform === 'linux' ? probeHasBinary('Xvfb') : false,
    interactiveSession: probeInteractiveSession(platform, env),
  };
  const decided = decideDisplay(probe);
  log.info(`display → ${decided.mode}${decided.display ? ` (${decided.display})` : ''}: ${decided.reason}`);
  return decided;
}
