// input:  a platform, and the stdout of the listening-port command run on it
// output: which command to run there, and the listening ports it reports
// pos:    Web UI transport host — platform dispatch for port discovery, local and remote
// >>> If I am updated, update CORTEX.md <<<


/**
 * VS Code does not solve this problem at all: its candidate finder is gated behind `isLinux` and
 * reads /proc/net/tcp directly, so on a Windows remote it falls back to scanning terminal output
 * for `localhost:PORT` and to the user typing a port by hand. We do the scan, because the Ports
 * list is opened by a human at human intervals rather than polled every two seconds — the cost VS
 * Code was avoiding is not one we pay.
 *
 * Each platform gets an ORDERED list of probes and the first that produces output wins, because
 * every single command here is missing somewhere real: `ss` needs iproute2, which BusyBox does not
 * provide and Alpine does not install; `/proc` is absent on macOS; `lsof` is preinstalled on macOS
 * but not on a slim Linux image. An empty list is the worst possible answer — it reads as "nothing
 * is running there" rather than as "we could not look".
 */

/** Privileged ports are never offered — nothing a dev server needs lives below 1024, and the
 *  accident (forwarding 22 or 3389) is worse than the inconvenience. */
export const MIN_FORWARDABLE_PORT = 1024;
const MIN_PORT = MIN_FORWARDABLE_PORT;

/** Marks where netstat output ends and the pid→name table begins in one round trip. */
const TASKLIST_MARKER = '#--tasklist--#';

/**
 * Windows has no `ss`. `netstat -ano` is present on every SKU including Server Core, costs ~50ms,
 * and needs no elevation — `Get-NetTCPConnection` is structured but pays a full second of
 * PowerShell startup, and `netstat -b` (process names) requires admin.
 *
 * `-p TCP` is deliberately NOT passed: Windows treats TCP and TCPv6 as separate protocols, so it
 * would silently drop every `[::]` listener. Plain `-ano` reports both under the proto `TCP`.
 *
 * `MSYS_NO_PATHCONV=1` is required because commands reach a Windows device through git-bash, which
 * rewrites the `/FO` switch into a filesystem path (`C:/Program Files/Git/FO`) and makes tasklist
 * fail. Verified on my-pc.
 */
export const WINDOWS_LISTENER_COMMAND =
  `netstat -ano; echo '${TASKLIST_MARKER}'; MSYS_NO_PATHCONV=1 tasklist /FO CSV /NH`;

/** Foreign address of a listening socket, in both families. Locale-independent — unlike the state
 *  column, which is translated ("侦听", "ABHÖREN") on a non-English Windows. */
const LISTEN_FOREIGN = new Set(['0.0.0.0:0', '[::]:0', '*:*']);

/** Addresses the reverse channel can actually connect to on the far side (it dials loopback). */
const REACHABLE = new Set(['0.0.0.0', '127.0.0.1', '[::]', '[::1]', '*']);

function parseTasklist(csv: string): Map<number, string> {
  const byPid = new Map<number, string>();
  for (const line of csv.split('\n')) {
    // "image name","pid","session","session#","mem" — the image name may itself contain a comma,
    // but the pid is always the second quoted field, so match the pair directly.
    const m = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (!m) continue;
    byPid.set(Number(m[2]), m[1].replace(/\.exe$/i, ''));
  }
  return byPid;
}

/**
 * Parse `netstat -ano` (optionally followed by a tasklist table) into listening ports.
 *
 * Rows look like:
 *   TCP    0.0.0.0:5173     0.0.0.0:0     LISTENING    1234
 *   TCP    [::]:5173        [::]:0        LISTENING    1234
 *   UDP    0.0.0.0:53       *:*                        4452
 * UDP is dropped: the forward is a TCP relay, so a UDP port is not a target it can offer.
 */
export function parseNetstatListeners(stdout: string): ListeningPort[] {
  const [netstat, tasklist] = stdout.split(TASKLIST_MARKER);
  const names = tasklist ? parseTasklist(tasklist) : new Map<number, string>();
  const out = new Map<number, ListeningPort>();
  for (const line of netstat.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4 || parts[0] !== 'TCP') continue;
    if (!LISTEN_FOREIGN.has(parts[2])) continue;
    const local = parts[1];
    const idx = local.lastIndexOf(':');
    if (idx < 0) continue;
    const port = Number(local.slice(idx + 1));
    if (!Number.isInteger(port) || port < MIN_PORT) continue;
    const address = local.slice(0, idx);
    if (!REACHABLE.has(address)) continue;
    const pid = Number(parts[parts.length - 1]);
    const process = names.get(pid) ?? null;
    const existing = out.get(port);
    // Prefer the entry that carries a process name, matching the `ss` parser.
    if (!existing || (!existing.process && process)) out.set(port, { port, address, process });
  }
  return [...out.values()].sort((a, b) => a.port - b.port);
}

// ── Linux ─────────────────────────────────────────────────────────────────────

export interface ListeningPort {
  port: number;
  /** Bound address as reported by `ss` — 127.0.0.1, 0.0.0.0, *, [::], … */
  address: string;
  /** Best-effort process name, or null when `ss` could not attribute it (no permission). */
  process: string | null;
}

/**
 * Parse `ss -ltnH` (with or without `-p`) into listening ports reachable over loopback.
 *
 * Lines look like:
 *   LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=1,fd=24))
 *   LISTEN 0 4096 *:3005 *:*
 * A port bound only to a non-loopback interface is dropped: the forward connects to 127.0.0.1,
 * so listing it would offer a target that cannot actually be reached.
 */
export function parseSsListeners(stdout: string): ListeningPort[] {
  const out = new Map<number, ListeningPort>();
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const local = parts[3];
    const idx = local.lastIndexOf(':');
    if (idx < 0) continue;
    const port = Number(local.slice(idx + 1));
    if (!Number.isInteger(port) || port < MIN_FORWARDABLE_PORT) continue;
    const address = local.slice(0, idx);
    const loopback = address === '127.0.0.1' || address === '[::1]' || address === '*' || address === '0.0.0.0' || address === '[::]';
    if (!loopback) continue;
    const proc = /users:\(\("([^"]+)"/.exec(line);
    const existing = out.get(port);
    // Prefer the entry that carries a process name.
    if (!existing || (!existing.process && proc)) {
      out.set(port, { port, address, process: proc ? proc[1] : null });
    }
  }
  return [...out.values()].sort((a, b) => a.port - b.port);
}

/**
 * Discover this host's own listening ports, using the same probe chain the device half uses.
 *
 * Sharing it is not tidiness: `ss` alone means an empty list on a container image without iproute2
 * and on macOS, and this half was the narrower one — a device could report ports its own server
 * could not. The commands are module constants with no interpolation, so running them through a
 * shell introduces nothing to inject.
 */

// ── macOS ─────────────────────────────────────────────────────────────────────

/**
 * macOS has neither `ss` nor `/proc`. `lsof` is preinstalled (`/usr/sbin/lsof`) and is the only
 * thing that reports both the port and the owning process without elevation.
 *
 * `-F cn` is the machine-readable field format: `p<pid>`, `c<command>`, `n<address>` one per line.
 * The default table truncates the command to nine characters (`cloudflar`), so the field form is
 * not a style choice — it is the difference between a usable label and a mangled one.
 */
export const MACOS_LISTENER_COMMAND = 'lsof -nP -iTCP -sTCP:LISTEN -F cn';

export function parseLsofListeners(stdout: string): ListeningPort[] {
  const out = new Map<number, ListeningPort>();
  let command: string | null = null;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    const tag = line[0];
    const value = line.slice(1);
    // A `p` record opens a process block; every `n` until the next `p` belongs to it.
    if (tag === 'p') command = null;
    else if (tag === 'c') command = value || null;
    else if (tag === 'n') {
      const idx = value.lastIndexOf(':');
      if (idx < 0) continue;
      const port = Number(value.slice(idx + 1));
      if (!Number.isInteger(port) || port < MIN_PORT) continue;
      const address = value.slice(0, idx);
      if (!REACHABLE.has(address)) continue;
      const existing = out.get(port);
      if (!existing || (!existing.process && command)) out.set(port, { port, address, process: command });
    }
  }
  return [...out.values()].sort((a, b) => a.port - b.port);
}

// ── Linux without iproute2 ────────────────────────────────────────────────────

/** TCP state for LISTEN in the /proc tables. */
const TCP_LISTEN = '0A';

/** Hex local addresses we can reach over loopback, in the little-endian form /proc prints. */
const PROC_REACHABLE = new Map<string, string>([
  ['00000000', '0.0.0.0'],
  ['0100007F', '127.0.0.1'],
  ['00000000000000000000000000000000', '[::]'],
  ['00000000000000000000000001000000', '[::1]'],
]);

/**
 * Last-resort probe for a Linux device with no `ss` — an Alpine or distroless container, where
 * BusyBox provides no `ss` applet at all. This is what VS Code reads, and it is the one source that
 * is always present when /proc is mounted.
 *
 * The cost is the process name: /proc gives a socket inode, and turning that into a pid means
 * walking every `/proc/<pid>/fd` symlink. We report null instead — a named port is nicer, but a
 * listed port is the thing that matters.
 */
export function parseProcNetTcp(stdout: string): ListeningPort[] {
  const out = new Map<number, ListeningPort>();
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/);
    // sl  local_address rem_address st ...
    if (parts.length < 4 || parts[3] !== TCP_LISTEN) continue;
    const [hexAddr, hexPort] = parts[1].split(':');
    const address = PROC_REACHABLE.get(hexAddr?.toUpperCase() ?? '');
    if (!address) continue;
    const port = parseInt(hexPort, 16);
    if (!Number.isInteger(port) || port < MIN_PORT) continue;
    if (!out.has(port)) out.set(port, { port, address, process: null });
  }
  return [...out.values()].sort((a, b) => a.port - b.port);
}

/** Both families in one read; `2>/dev/null` so a kernel without IPv6 still yields the IPv4 table. */
export const PROC_LISTENER_COMMAND = 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null';

export interface ListenerProbe {
  command: string;
  parse: (stdout: string) => ListeningPort[];
}

/**
 * Commands to try on a device, in order — the first that produces output wins.
 */
export function listenerProbes(platform: string): ListenerProbe[] {
  if (platform === 'win32') {
    return [{ command: WINDOWS_LISTENER_COMMAND, parse: parseNetstatListeners }];
  }
  if (platform === 'darwin') {
    return [{ command: MACOS_LISTENER_COMMAND, parse: parseLsofListeners }];
  }
  return [
    // `ss -p` needs no privileges for own-user sockets, so the named form is tried first.
    { command: 'ss -ltnpH', parse: parseSsListeners },
    { command: 'ss -ltnH', parse: parseSsListeners },
    // No iproute2 (BusyBox, distroless): ports without names beats no ports.
    { command: PROC_LISTENER_COMMAND, parse: parseProcNetTcp },
  ];
}
