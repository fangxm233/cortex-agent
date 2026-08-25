// input:  real netstat/tasklist output from a Windows device
// output: pinned platform dispatch and the Windows listening-port parse
// pos:    tests for device port discovery across platforms
// >>> If I am updated, update CORTEX.md <<<
import { describe, it, expect } from 'vitest';
import {
  listenerProbes, parseLsofListeners, parseNetstatListeners, parseProcNetTcp,
  MACOS_LISTENER_COMMAND, PROC_LISTENER_COMMAND, WINDOWS_LISTENER_COMMAND,
} from '@platform/ui-http/device-listeners.js';

// Captured verbatim from `my-pc` (Windows 11, code page 65001).
const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:22             0.0.0.0:0              LISTENING       5596
  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4
  TCP    127.0.0.1:5939         0.0.0.0:0              LISTENING       6172
  TCP    127.0.0.1:8384         0.0.0.0:0              LISTENING       150740
  TCP    127.0.0.1:4767         127.0.0.1:61858        ESTABLISHED     6084
  TCP    [::]:22                [::]:0                 LISTENING       5596
  TCP    192.168.1.20:139       0.0.0.0:0              LISTENING       4
  UDP    0.0.0.0:53             *:*                                    4452
#--tasklist--#
"System Idle Process","0","Services","0","8 K"
"System","4","Services","0","26,896 K"
"TeamViewer_Service.exe","6172","Services","0","41,000 K"
"syncthing.exe","150740","Console","1","120,000 K"
`;

describe('parseNetstatListeners', () => {
  const ports = parseNetstatListeners(NETSTAT);

  it('keeps loopback-reachable TCP listeners and attaches process names', () => {
    expect(ports).toEqual([
      { port: 5939, address: '127.0.0.1', process: 'TeamViewer_Service' },
      { port: 8384, address: '127.0.0.1', process: 'syncthing' },
    ]);
  });

  it('recognises listeners by foreign address, not by the state word', () => {
    // "LISTENING" is translated on a non-English Windows ("侦听", "ABHÖREN"); the 0.0.0.0:0 /
    // [::]:0 foreign address is not.
    const translated = NETSTAT.replace(/LISTENING/g, '侦听');
    expect(parseNetstatListeners(translated)).toEqual(ports);
  });

  it('drops established connections, UDP, and privileged or unreachable ports', () => {
    const found = ports.map((p) => p.port);
    expect(found).not.toContain(61858); // established peer port
    expect(found).not.toContain(53); // UDP
    expect(found).not.toContain(22); // below 1024
    expect(found).not.toContain(139); // bound to a LAN address only
  });

  it('reports a port with no matching tasklist row rather than dropping it', () => {
    const orphan = '  TCP    127.0.0.1:6006         0.0.0.0:0              LISTENING       999999\n';
    expect(parseNetstatListeners(orphan)).toEqual([{ port: 6006, address: '127.0.0.1', process: null }]);
  });

  it('survives output with no tasklist section at all', () => {
    expect(parseNetstatListeners(NETSTAT.split('#--tasklist--#')[0]).map((p) => p.port))
      .toEqual([5939, 8384]);
  });

  it('returns nothing for empty or unrelated output', () => {
    expect(parseNetstatListeners('')).toEqual([]);
    expect(parseNetstatListeners('command not found')).toEqual([]);
  });
});

// Captured verbatim from `lsof -nP -iTCP -sTCP:LISTEN -F cn` on this host.
const LSOF = `p128818
cnode
f19
n127.0.0.1:4851
p607824
ccloudflared
f10
n127.0.0.1:20241
p634234
cnode
f18
n*:8899
p1170040
cssh
f5
n127.0.0.1:812
`;

describe('parseLsofListeners', () => {
  it('reads the field format so the command name is not truncated', () => {
    // The default lsof table cuts COMMAND to nine characters — `cloudflared` arrives as
    // `cloudflar`, which is a mangled label rather than a useful one.
    expect(parseLsofListeners(LSOF)).toEqual([
      { port: 4851, address: '127.0.0.1', process: 'node' },
      { port: 8899, address: '*', process: 'node' },
      { port: 20241, address: '127.0.0.1', process: 'cloudflared' },
    ]);
  });

  it('drops privileged ports and ignores unparseable lines', () => {
    expect(parseLsofListeners(LSOF).some((p) => p.port === 812)).toBe(false);
    expect(parseLsofListeners('')).toEqual([]);
    expect(parseLsofListeners('lsof: command not found')).toEqual([]);
  });

  it('is what macOS gets, since it has neither ss nor /proc', () => {
    const probes = listenerProbes('darwin');
    expect(probes.map((p) => p.command)).toEqual([MACOS_LISTENER_COMMAND]);
    expect(MACOS_LISTENER_COMMAND).toContain('-F cn');
  });
});

// Captured verbatim from /proc/net/tcp and /proc/net/tcp6 on this host.
const PROC = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 3500007F:0035 00000000:0000 0A 00000000:00000000 00:00000000 00000000   101        0 318922432 1 0000000000000000 100 0 0 10 5
   1: 0100007F:4F11 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1508620272        0 328212430 2 0000000000000000 100 0 0 10 0
   2: 0100007F:0BB9 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1508620272        0 385693029 1 0000000000000000 100 0 0 10 0
   3: 1401A8C0:1F90 0100007F:9C40 01 00000000:00000000 00:00000000 00000000 1508620272        0 385693031 1 0000000000000000 100 0 0 10 0
  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:22C3 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 1508620272        0 160761918 1 0000000000000000 100 0 0 10 0
`;

describe('parseProcNetTcp', () => {
  it('decodes the little-endian hex tables both families use', () => {
    expect(parseProcNetTcp(PROC)).toEqual([
      { port: 3001, address: '127.0.0.1', process: null },  // 0BB9
      { port: 8899, address: '[::]', process: null },       // 22C3
      { port: 20241, address: '127.0.0.1', process: null }, // 4F11
    ]);
  });

  it('drops non-listening rows, privileged ports and LAN-only binds', () => {
    const ports = parseProcNetTcp(PROC).map((p) => p.port);
    expect(ports).not.toContain(8080); // st 01 — established, not LISTEN
    expect(ports).not.toContain(53); // 0035, below 1024
    // 1401A8C0 is 192.168.1.20 — the reverse channel dials loopback, so it could never reach it.
    expect(parseProcNetTcp(PROC).some((p) => p.address.startsWith('192.'))).toBe(false);
  });

  it('reports no process names, which is the price of needing no package', () => {
    // /proc gives a socket inode; resolving it means walking every /proc/<pid>/fd symlink.
    expect(parseProcNetTcp(PROC).every((p) => p.process === null)).toBe(true);
  });

  it('backs up ss on a Linux box with no iproute2', () => {
    // BusyBox has no `ss` applet and Alpine does not install iproute2, so a container device would
    // otherwise report an empty list — which reads as "nothing is running there".
    const commands = listenerProbes('linux').map((p) => p.command);
    expect(commands).toEqual(['ss -ltnpH', 'ss -ltnH', PROC_LISTENER_COMMAND]);
  });
});

describe('listenerProbes', () => {
  it('asks Windows for netstat, without -p TCP', () => {
    const probes = listenerProbes('win32');
    expect(probes).toHaveLength(1);
    expect(probes[0].command).toBe(WINDOWS_LISTENER_COMMAND);
    // `-p TCP` would silently drop every [::] listener — Windows counts TCPv6 as its own protocol.
    expect(WINDOWS_LISTENER_COMMAND).not.toContain('-p TCP');
    // git-bash rewrites a bare /FO into a filesystem path, which makes tasklist fail outright.
    expect(WINDOWS_LISTENER_COMMAND).toContain('MSYS_NO_PATHCONV=1');
  });

  it('falls back to ss plus /proc for anything not explicitly handled', () => {
    for (const platform of ['linux', 'freebsd', '']) {
      expect(listenerProbes(platform).map((p) => p.command))
        .toEqual(['ss -ltnpH', 'ss -ltnH', PROC_LISTENER_COMMAND]);
    }
  });
});
