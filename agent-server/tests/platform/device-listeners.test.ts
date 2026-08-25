// input:  real netstat/tasklist output from a Windows device
// output: pinned platform dispatch and the Windows listening-port parse
// pos:    tests for device port discovery across platforms
// >>> If I am updated, update CORTEX.md <<<
import { describe, it, expect } from 'vitest';
import {
  listenerProbes, parseNetstatListeners, WINDOWS_LISTENER_COMMAND,
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

  it('keeps the privileged/unprivileged ss pair everywhere else', () => {
    for (const platform of ['linux', 'darwin', '']) {
      expect(listenerProbes(platform).map((p) => p.command)).toEqual(['ss -ltnpH', 'ss -ltnH']);
    }
  });
});
