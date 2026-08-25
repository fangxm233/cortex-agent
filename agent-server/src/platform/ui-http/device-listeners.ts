// input:  a device's platform, and the stdout of the listening-port command run there
// output: which command to run on that device, and the ports it reports
// pos:    Web UI transport host — platform dispatch for device port discovery
// >>> If I am updated, update CORTEX.md <<<

import { parseSsListeners, type ListeningPort } from './port-forward.js';

/**
 * VS Code does not solve this problem at all: its candidate finder is gated behind `isLinux` and
 * reads /proc/net/tcp directly, so on a Windows remote it falls back to scanning terminal output
 * for `localhost:PORT` and to the user typing a port by hand. We do the scan, because the Ports
 * list is opened by a human at human intervals rather than polled every two seconds — the cost VS
 * Code was avoiding is not one we pay.
 */

/** Same floor as the local forward: nothing a dev server needs lives below 1024. */
const MIN_PORT = 1024;

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

export interface ListenerProbe {
  command: string;
  parse: (stdout: string) => ListeningPort[];
}

/**
 * Commands to try on a device, in order — the first that produces output wins. Linux keeps the
 * privileged/unprivileged `ss` pair; Windows needs only one call because netstat never needs
 * elevation for the parts we read.
 */
export function listenerProbes(platform: string): ListenerProbe[] {
  if (platform === 'win32') {
    return [{ command: WINDOWS_LISTENER_COMMAND, parse: parseNetstatListeners }];
  }
  return [
    { command: 'ss -ltnpH', parse: parseSsListeners },
    { command: 'ss -ltnH', parse: parseSsListeners },
  ];
}
