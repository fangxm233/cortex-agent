import * as fs from 'fs';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '@core/log.js';

const execFileAsync = promisify(execFile);

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
// All asynchronous: they run inside the daemon, and a synchronous probe stalls every session for
// as long as an X server takes to answer (up to the timeout, per socket).

/** X sockets owned by this uid AND actually connectable. Ownership alone is not enough: the socket
 *  may exist while XAUTHORITY denies us, and a display we cannot open would fail at launch. */
export async function probeUsableDisplays(): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.promises.readdir('/tmp/.X11-unix');
  } catch {
    return [];
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const checked = await Promise.all(
    names
      .filter((name) => /^X\d+$/.test(name))
      .map(async (name) => {
        try {
          const st = await fs.promises.stat(`/tmp/.X11-unix/${name}`);
          if (uid >= 0 && st.uid !== uid) return null; // never draw onto another user's screen
        } catch {
          return null;
        }
        const display = `:${name.slice(1)}`;
        return (await canOpenDisplay(display)) ? display : null;
      }),
  );
  // Lowest display number first — deterministic, and the console/primary session sorts first.
  return checked
    .filter((d): d is string => d !== null)
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

async function canOpenDisplay(display: string): Promise<boolean> {
  const probes: Array<[string, string[]]> = [
    ['xdpyinfo', ['-display', display]],
    ['xset', ['-display', display, 'q']],
  ];
  for (const [bin, args] of probes) {
    const result = await runProbe(bin, args, 3000);
    if (result === 'missing') continue;
    return result === 0; // anything but success = the display refused us
  }
  // Neither probe exists: fall back to "socket exists and is ours". Weaker, but refusing every
  // display on a machine without x11-utils would be worse.
  log.warn('neither xdpyinfo nor xset is installed — trusting X socket ownership');
  return true;
}

/** Run a probe to completion without buffering its output (xdpyinfo is verbose). Resolves the exit
 *  code, -1 for a timeout or signal, or 'missing' when the binary is not installed. */
function runProbe(bin: string, args: string[], timeoutMs: number): Promise<number | 'missing'> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: 'ignore', timeout: timeoutMs });
    child.once('error', (e) => resolve((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : -1));
    child.once('exit', (code) => resolve(code ?? -1));
  });
}

export async function probeHasBinary(bin: string): Promise<boolean> {
  return (await runProbe('which', [bin], 2000)) === 0;
}

/** macOS: a GUI (Aqua) session. Windows: anything but the service session. */
export async function probeInteractiveSession(platform: NodeJS.Platform, env = process.env): Promise<boolean> {
  if (platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('launchctl', ['managername'], { encoding: 'utf8', timeout: 2000 });
      return stdout.trim() === 'Aqua';
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

/** First display number at or above `from` that no X server claims — neither a lock file nor a
 *  socket, whoever owns it (a stale lock still makes Xvfb refuse the number). */
export function pickFreeDisplay(from: number, tmpDir = '/tmp'): number | null {
  for (let n = from; n < from + 100; n++) {
    const taken =
      fs.existsSync(path.join(tmpDir, `.X${n}-lock`)) || fs.existsSync(path.join(tmpDir, '.X11-unix', `X${n}`));
    if (!taken) return n;
  }
  return null;
}

/** Full resolution for this host. An operator override short-circuits every probe. */
export async function resolveBrowserDisplay(env = process.env): Promise<BrowserDisplay> {
  const platform = process.platform;
  const override = env.CORTEX_BROWSER_DISPLAY;
  const probeX = platform === 'linux' && !override;
  const [usableDisplays, hasXvfb, interactiveSession] = await Promise.all([
    probeX ? probeUsableDisplays() : [],
    probeX ? probeHasBinary('Xvfb') : false,
    override ? false : probeInteractiveSession(platform, env),
  ]);
  const decided = decideDisplay({
    platform,
    override,
    envDisplay: env.DISPLAY,
    usableDisplays,
    hasXvfb,
    interactiveSession,
  });
  log.info(`display → ${decided.mode}${decided.display ? ` (${decided.display})` : ''}: ${decided.reason}`);
  return decided;
}
