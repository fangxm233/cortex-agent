// input:  strace lines, initial cwd, and C8 policy roots
// output: complete allowed counts and fail-closed access violations
// pos:    Pure parser and classifier for benchmark access traces
// >>> If I am updated, update my header and folder CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';

export type AccessMode = 'read' | 'write' | 'network' | 'unknown';

export interface AccessViolation {
  syscall: string;
  path: string;
  reason: string;
  access: AccessMode;
  pid: number;
  traceFile: string;
  line: number;
  raw: string;
}

export interface AccessProbePolicy {
  workspace: string;
  cortexHome: string;
  logsDir: string;
  installRoot: string;
  hostHome: string;
  hostCortexHome: string;
  nodeExecutable: string;
  nodeModuleRoots?: string[];
}

export interface AccessProbeCounts {
  traceLines: number;
  fileCalls: number;
  networkCalls: number;
  allowed: number;
}

export interface TraceClassification {
  violations: AccessViolation[];
  counts: AccessProbeCounts;
}

interface ParsedCall {
  syscall: string;
  args: string[];
  result: string;
}

interface PathArgument {
  pathIndex: number;
  dirIndex?: number;
}

interface TraceOptions {
  policy: AccessProbePolicy;
  initialCwd: string;
  pid: number;
  traceFile: string;
}

const DIRECT_PATH = [{ pathIndex: 0 }];
const AT_PATH = [{ pathIndex: 1, dirIndex: 0 }];
const FILE_ARGUMENTS: Record<string, PathArgument[]> = {
  access: DIRECT_PATH,
  chdir: DIRECT_PATH,
  chmod: DIRECT_PATH,
  chown: DIRECT_PATH,
  creat: DIRECT_PATH,
  execve: DIRECT_PATH,
  lchown: DIRECT_PATH,
  link: [{ pathIndex: 0 }, { pathIndex: 1 }],
  lstat: DIRECT_PATH,
  mkdir: DIRECT_PATH,
  mknod: DIRECT_PATH,
  mount: [{ pathIndex: 0 }, { pathIndex: 1 }],
  open: DIRECT_PATH,
  readlink: DIRECT_PATH,
  rename: [{ pathIndex: 0 }, { pathIndex: 1 }],
  rmdir: DIRECT_PATH,
  stat: DIRECT_PATH,
  statfs: DIRECT_PATH,
  symlink: [{ pathIndex: 1 }],
  truncate: DIRECT_PATH,
  umount: DIRECT_PATH,
  umount2: DIRECT_PATH,
  unlink: DIRECT_PATH,
  utime: DIRECT_PATH,
  utimes: DIRECT_PATH,
  execveat: AT_PATH,
  faccessat: AT_PATH,
  faccessat2: AT_PATH,
  getcwd: DIRECT_PATH,
  inotify_add_watch: [{ pathIndex: 1 }],
  fchmodat: AT_PATH,
  fchownat: AT_PATH,
  mkdirat: AT_PATH,
  mknodat: AT_PATH,
  name_to_handle_at: AT_PATH,
  newfstatat: AT_PATH,
  openat: AT_PATH,
  openat2: AT_PATH,
  readlinkat: AT_PATH,
  statx: AT_PATH,
  unlinkat: AT_PATH,
  utimensat: AT_PATH,
  linkat: [{ pathIndex: 1, dirIndex: 0 }, { pathIndex: 3, dirIndex: 2 }],
  renameat: [{ pathIndex: 1, dirIndex: 0 }, { pathIndex: 3, dirIndex: 2 }],
  renameat2: [{ pathIndex: 1, dirIndex: 0 }, { pathIndex: 3, dirIndex: 2 }],
  symlinkat: [{ pathIndex: 2, dirIndex: 1 }],
};

const WRITE_SYSCALLS = new Set([
  'chmod', 'chown', 'creat', 'fchmodat', 'fchownat', 'lchown', 'link', 'linkat', 'mkdir',
  'mkdirat', 'mknod', 'mknodat', 'mount', 'rename', 'renameat', 'renameat2', 'rmdir', 'symlink',
  'symlinkat', 'truncate', 'umount', 'umount2', 'unlink', 'unlinkat', 'utime', 'utimensat', 'utimes',
]);
const PROCESS_METADATA = new Set([
  'clone', 'clone3', 'exit', 'exit_group', 'fork', 'kill', 'setpgid', 'tgkill', 'vfork', 'wait4',
  'waitid',
]);
const NETWORK_DENIALS: Record<string, string> = {
  bind: 'network_bind_denied',
  listen: 'network_listen_denied',
  connect: 'network_connect_denied',
};
const NETWORK_METADATA = new Set([
  'accept', 'accept4', 'getpeername', 'getsockname', 'getsockopt', 'recvfrom', 'recvmmsg', 'recvmsg',
  'sendmmsg', 'sendmsg', 'sendto', 'setsockopt', 'shutdown', 'socket', 'socketpair',
]);
const SYSTEM_ROOTS = [
  '/lib', '/lib64', '/usr/lib', '/usr/lib64', '/usr/share/zoneinfo', '/sys/fs/cgroup',
  '/sys/devices/system/cpu', '/sys/kernel/mm',
];
const SYSTEM_FILES = new Set([
  '/dev/null', '/dev/random', '/dev/urandom', '/etc/gai.conf', '/etc/host.conf', '/etc/hosts',
  '/etc/ld.so.cache', '/etc/ld.so.preload', '/etc/localtime', '/etc/netsvc.conf',
  '/etc/nsswitch.conf', '/etc/resolv.conf', '/etc/services', '/etc/ssl/openssl.cnf',
  '/etc/svc.conf', '/proc/cpuinfo', '/proc/filesystems', '/proc/meminfo', '/proc/stat',
  '/proc/sys/vm/overcommit_memory', '/proc/version_signature',
]);

function splitArguments(value: string): string[] {
  const result: string[] = [];
  let start = 0;
  let quote = false;
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) escaped = false;
    else if (char === '\\' && quote) escaped = true;
    else if (char === '"') quote = !quote;
    else if (!quote && '{[('.includes(char)) depth += 1;
    else if (!quote && '}])'.includes(char)) depth -= 1;
    else if (!quote && depth === 0 && char === ',') {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(value.slice(start).trim());
  return result;
}

function parseTraceCall(raw: string): ParsedCall | null {
  const withoutPid = raw.replace(/^\[pid\s+\d+\]\s+/, '');
  const body = withoutPid.replace(/^\d+(?:\.\d+)?\s+/, '');
  const match = /^([A-Za-z0-9_]+)\((.*)\)\s+=\s+(.+)$/.exec(body);
  if (!match) return null;
  return { syscall: match[1], args: splitArguments(match[2]), result: match[3] };
}

function decodeQuoted(value: string): string | null {
  const match = /^"((?:[^"\\]|\\.)*)"/.exec(value.trim());
  if (!match) return null;
  const jsonEscaped = match[1].replace(/\\([0-7]{1,3})/g, (_whole, octal) => (
    `\\u${Number.parseInt(octal, 8).toString(16).padStart(4, '0')}`
  ));
  try {
    return JSON.parse(`"${jsonEscaped}"`);
  } catch {
    return null;
  }
}

function annotatedPath(value: string): string | null {
  const match = /<(\/[^>]*)>/.exec(value);
  return match?.[1] ?? null;
}

function resolveTracedPath(
  argument: string, dirArgument: string | undefined, cwd: string,
): string | null {
  const value = decodeQuoted(argument);
  if (value === null) return null;
  if (path.isAbsolute(value)) return path.normalize(value);
  const base = dirArgument === undefined || dirArgument.startsWith('AT_FDCWD')
    ? annotatedPath(dirArgument ?? '') ?? cwd
    : annotatedPath(dirArgument);
  return base ? path.resolve(base, value) : null;
}

function canonicalPath(value: string): string {
  const absolute = path.resolve(value);
  let cursor = absolute;
  const suffix: string[] = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return absolute;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  try {
    return path.join(fs.realpathSync(cursor), ...suffix);
  } catch {
    return absolute;
  }
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..'
    && !path.isAbsolute(relative));
}

function isHostDotfile(candidate: string, policy: AccessProbePolicy): boolean {
  if (!isWithin(candidate, policy.hostHome)) return false;
  const first = path.relative(policy.hostHome, candidate).split(path.sep)[0];
  return first.startsWith('.');
}

function isProcessRuntimePath(candidate: string, pid: number): boolean {
  return isWithin(candidate, '/proc/self')
    || isWithin(candidate, '/proc/thread-self')
    || isWithin(candidate, `/proc/${pid}`)
    || /^\/proc\/\d+(?:\/|$)/.test(candidate);
}

function readOnlyRoots(policy: AccessProbePolicy): string[] {
  return [policy.installRoot, ...(policy.nodeModuleRoots ?? []), ...SYSTEM_ROOTS];
}

function nodeRuntimeRoot(policy: AccessProbePolicy): string {
  return path.dirname(path.dirname(canonicalPath(policy.nodeExecutable)));
}

function isAllowedRootAncestor(candidate: string, policy: AccessProbePolicy): boolean {
  const roots = [
    policy.installRoot,
    ...(policy.nodeModuleRoots ?? []),
    nodeRuntimeRoot(policy),
    ...SYSTEM_ROOTS,
    ...SYSTEM_FILES,
  ];
  return roots.some(root => isWithin(root, candidate));
}

function classifyPath(
  candidate: string, access: AccessMode, policy: AccessProbePolicy, pid: number,
): string | null {
  const canonical = canonicalPath(candidate);
  if (isWithin(canonical, nodeRuntimeRoot(policy)) && access === 'read') return null;
  if (isWithin(candidate, policy.hostCortexHome)) return 'host_cortex_path';
  if (isHostDotfile(candidate, policy)) return 'host_home_dotfile';
  const writable = [policy.workspace, policy.cortexHome, policy.logsDir];
  if (writable.some(root => isWithin(canonical, root))) return null;
  if (canonical === canonicalPath(policy.nodeExecutable) && access === 'read') return null;
  if (isAllowedRootAncestor(canonical, policy) && access === 'read') return null;
  if ((SYSTEM_FILES.has(candidate) || isProcessRuntimePath(candidate, pid)) && access === 'read') {
    return null;
  }
  const readOnly = readOnlyRoots(policy).some(root => isWithin(canonical, root));
  if (readOnly && access === 'read') return null;
  if (readOnly) return 'read_only_root_write';
  return 'unclassified_path';
}

function accessMode(call: ParsedCall): AccessMode {
  if (WRITE_SYSCALLS.has(call.syscall)) return 'write';
  if (call.syscall === 'access' || call.syscall.startsWith('faccessat')) {
    return call.args.some(argument => argument.includes('W_OK')) ? 'write' : 'read';
  }
  if (call.syscall === 'open' || call.syscall === 'openat' || call.syscall === 'openat2') {
    const flags = call.args.join(',');
    return /O_(?:WRONLY|RDWR|CREAT|TRUNC|APPEND|TMPFILE)/.test(flags) ? 'write' : 'read';
  }
  return 'read';
}

function endpointFromSockaddr(args: string[]): string | null {
  const text = args.join(',');
  const unix = /sun_path=(?:@)?"([^"]+)"/.exec(text);
  if (unix) return unix[1].startsWith('/') ? unix[1] : `unix:@${unix[1]}`;
  const address = /(?:inet_addr\(|inet_pton\([^,]+,\s*)"([^"]+)"/.exec(text)?.[1];
  const port = /sin6?_port=htons\((\d+)\)/.exec(text)?.[1];
  return address && port ? `${address}:${port}` : null;
}

function endpointFromFd(argument: string): string | null {
  const match = /<(?:TCP|TCPv6):\[([^\]]+)\]>/.exec(argument);
  return match?.[1] ?? null;
}

function violation(
  syscall: string, offender: string, reason: string, access: AccessMode,
  options: TraceOptions, line: number, raw: string,
): AccessViolation {
  return {
    syscall,
    path: offender,
    reason,
    access,
    pid: options.pid,
    traceFile: options.traceFile,
    line,
    raw,
  };
}

function classifyNetwork(
  call: ParsedCall, options: TraceOptions, line: number, raw: string,
): AccessViolation | null {
  const reason = NETWORK_DENIALS[call.syscall];
  if (reason) {
    const endpoint = call.syscall === 'listen'
      ? endpointFromFd(call.args[0])
      : endpointFromSockaddr(call.args);
    return violation(call.syscall, endpoint ?? `fd:${call.args[0] ?? 'unknown'}`, reason,
      'network', options, line, raw);
  }
  if (NETWORK_METADATA.has(call.syscall)) return null;
  return violation(call.syscall, raw, 'unclassified_network_syscall', 'unknown', options, line, raw);
}

function unknownViolation(
  call: ParsedCall | null, options: TraceOptions, line: number, raw: string,
): AccessViolation {
  const syscall = call?.syscall ?? 'trace';
  const offender = call?.args.map(decodeQuoted).find(value => value !== null) ?? raw;
  const reason = call ? 'unclassified_syscall' : 'trace_parse_failed';
  return violation(syscall, offender, reason, 'unknown', options, line, raw);
}

function classifyFile(
  call: ParsedCall, cwd: string, options: TraceOptions, line: number, raw: string,
): { violations: AccessViolation[]; paths: string[] } {
  const specs = FILE_ARGUMENTS[call.syscall];
  if (!specs) return { violations: [unknownViolation(call, options, line, raw)], paths: [] };
  const access = accessMode(call);
  const paths = specs.map(spec => resolveTracedPath(
    call.args[spec.pathIndex],
    spec.dirIndex === undefined ? undefined : call.args[spec.dirIndex],
    cwd,
  ));
  const violations = paths.flatMap((candidate) => {
    if (!candidate) return [violation(call.syscall, raw, 'unclassifiable_path', 'unknown',
      options, line, raw)];
    const reason = classifyPath(candidate, access, options.policy, options.pid);
    return reason ? [violation(call.syscall, candidate, reason, access, options, line, raw)] : [];
  });
  return { violations, paths: paths.filter((value): value is string => value !== null) };
}

function isNetworkCall(call: ParsedCall): boolean {
  return call.syscall in NETWORK_DENIALS || NETWORK_METADATA.has(call.syscall);
}

function isSignalMetadata(raw: string): boolean {
  return /^(?:\[pid\s+\d+\]\s+)?\d+(?:\.\d+)?\s+--- SIG[A-Z0-9]+ /.test(raw);
}

function emptyCounts(): AccessProbeCounts {
  return { traceLines: 0, fileCalls: 0, networkCalls: 0, allowed: 0 };
}

export function classifyTraceLines(lines: string[], options: TraceOptions): TraceClassification {
  const counts = emptyCounts();
  const violations: AccessViolation[] = [];
  let cwd = path.resolve(options.initialCwd);
  lines.forEach((raw, index) => {
    if (raw.length === 0) return;
    counts.traceLines += 1;
    if (isSignalMetadata(raw)) return;
    const call = parseTraceCall(raw);
    if (!call) return void violations.push(unknownViolation(null, options, index + 1, raw));
    if (isNetworkCall(call)) {
      counts.networkCalls += 1;
      const denied = classifyNetwork(call, options, index + 1, raw);
      if (denied) violations.push(denied);
      else counts.allowed += 1;
      return;
    }
    if (PROCESS_METADATA.has(call.syscall)) return;
    const result = classifyFile(call, cwd, options, index + 1, raw);
    counts.fileCalls += Math.max(result.paths.length, 1);
    violations.push(...result.violations);
    counts.allowed += Math.max(result.paths.length, 1) - result.violations.length;
    if (call.syscall === 'chdir' && !call.result.startsWith('-1') && result.paths[0]) cwd = result.paths[0];
  });
  return { violations, counts };
}
