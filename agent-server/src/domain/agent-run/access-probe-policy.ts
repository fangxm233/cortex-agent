// input:  strace stream, initial cwd, and C8 policy roots
// output: bounded counts, root-metadata allowances and violations
// pos:    Stateful classifier for benchmark access traces
// >>> If I am updated, update my header and folder CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

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
  tracedPids?: ReadonlySet<number>;
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

interface ProcessState {
  cwd: string | null;
  fds: Map<number, string>;
}

interface ParsedPrefix {
  body: string;
  pid: number;
}

interface PendingCall {
  body: string;
  line: number;
  raw: string;
  syscall: string;
}

export interface AccessTraceOptions {
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
const PHYSICAL_RESOLUTION_SYSCALLS = new Set([
  'access', 'faccessat', 'faccessat2', 'lstat', 'newfstatat', 'readlink', 'readlinkat', 'stat',
  'statx',
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
const NETWORK_SYSCALLS = new Set([
  'accept', 'accept4', 'bind', 'connect', 'getpeername', 'getsockname', 'getsockopt', 'listen',
  'recvfrom', 'recvmmsg', 'recvmsg', 'sendmmsg', 'sendmsg', 'sendto', 'setsockopt', 'shutdown',
  'socket', 'socketpair',
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

function parsePrefix(raw: string, fallbackPid: number): ParsedPrefix {
  const bracketed = /^\[pid\s+(\d+)\]\s+(.+)$/.exec(raw);
  if (bracketed) return { pid: Number(bracketed[1]), body: bracketed[2] };
  const combined = /^(\d+)\s+(\d+(?:\.\d+)?\s+.+)$/.exec(raw);
  if (combined) return { pid: Number(combined[1]), body: combined[2] };
  return { pid: fallbackPid, body: raw };
}

function parseTraceCall(body: string): ParsedCall | null {
  const callBody = body.replace(/^\d+(?:\.\d+)?\s+/, '');
  const match = /^([A-Za-z0-9_]+)\((.*)\)\s+=\s+(.+)$/.exec(callBody);
  if (!match) return null;
  return { syscall: match[1], args: splitArguments(match[2]), result: match[3] };
}

function decodeQuoted(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^"((?:[^"\\]|\\.)*)"/.exec(value.trim());
  if (!match) return null;
  const jsonEscaped = match[1].replace(/\\([0-7]{1,3})/g, (_whole, octal) => (
    `\\u${Number.parseInt(octal, 8).toString(16).padStart(4, '0')}`
  ));
  try { return JSON.parse(`"${jsonEscaped}"`); }
  catch { return null; }
}

function annotatedPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /<(\/[^>]*)>/.exec(value)?.[1] ?? null;
}

function appendRaw(base: string, segments: string[]): string {
  if (segments.length === 0) return base;
  const separator = base.endsWith(path.sep) ? '' : path.sep;
  return `${base}${separator}${segments.join(path.sep)}`;
}

function dirBase(argument: unknown, state: ProcessState): string | null {
  if (argument === undefined || String(argument).startsWith('AT_FDCWD')) {
    return annotatedPath(argument) ?? state.cwd;
  }
  const annotated = annotatedPath(argument);
  if (annotated) return annotated;
  const fd = Number.parseInt(String(argument), 10);
  return Number.isSafeInteger(fd) ? state.fds.get(fd) ?? null : null;
}

function resolveTracedPath(
  argument: unknown, dirArgument: unknown, state: ProcessState,
): string | null {
  const value = decodeQuoted(argument);
  if (value === null) return null;
  if (path.isAbsolute(value)) return value;
  const base = dirBase(dirArgument, state);
  if (!base) return null;
  return value.length === 0 ? base : appendRaw(base, [value]);
}

function resolveKnownSymlinks(
  value: string, symlinks: ReadonlyMap<string, string>, followFinal: boolean, depth = 0,
): string {
  const absolute = path.isAbsolute(value) ? value : appendRaw(process.cwd(), [value]);
  if (depth >= 40) return absolute;
  const parsed = path.parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] === '..') { cursor = path.dirname(cursor); continue; }
    if (segments[index] === '.') continue;
    const next = path.join(cursor, segments[index]);
    let target = symlinks.get(next);
    if (target === undefined) {
      try { if (fs.lstatSync(next).isSymbolicLink()) target = fs.readlinkSync(next); }
      catch {}
    }
    if (target !== undefined && (followFinal || index < segments.length - 1)) {
      const resolved = path.isAbsolute(target) ? target : appendRaw(path.dirname(next), [target]);
      return resolveKnownSymlinks(appendRaw(resolved, segments.slice(index + 1)),
        symlinks, followFinal, depth + 1);
    }
    cursor = next;
  }
  return cursor;
}

function canonicalFsPath(value: string, followFinal: boolean, depth = 0): string {
  if (depth >= 40) return value;
  const parsed = path.parse(value);
  const segments = value.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  for (let index = 0; index < segments.length; index += 1) {
    const next = path.join(cursor, segments[index]);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(next); }
    catch { return appendRaw(next, segments.slice(index + 1)); }
    if (stat.isSymbolicLink() && (followFinal || index < segments.length - 1)) {
      let target: string;
      try { target = fs.readlinkSync(next); }
      catch { return appendRaw(next, segments.slice(index + 1)); }
      const resolved = path.isAbsolute(target) ? target : appendRaw(path.dirname(next), [target]);
      return canonicalFsPath(appendRaw(resolved, segments.slice(index + 1)), followFinal, depth + 1);
    }
    cursor = next;
  }
  try { return followFinal ? fs.realpathSync(cursor) : cursor; }
  catch { return value; }
}

function canonicalPath(
  value: string, symlinks: ReadonlyMap<string, string> = new Map(), followFinal = true,
): string {
  return canonicalFsPath(resolveKnownSymlinks(value, symlinks, followFinal), followFinal);
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

const SAFE_PROC_FILES = new Set(['auxv', 'cgroup', 'exe', 'maps', 'stat', 'statm', 'status']);

function isProcessRuntimePath(
  candidate: string, pid: number, tracedPids: ReadonlySet<number> | undefined,
): boolean {
  const match = /^\/proc\/(self|thread-self|\d+)\/([^/]+)$/.exec(candidate);
  if (!match || !SAFE_PROC_FILES.has(match[2])) return false;
  if (match[1] === 'self' || match[1] === 'thread-self') return true;
  const targetPid = Number(match[1]);
  return targetPid === pid || tracedPids?.has(targetPid) === true;
}

function readOnlyRoots(policy: AccessProbePolicy): string[] {
  return [policy.installRoot, ...(policy.nodeModuleRoots ?? []), ...SYSTEM_ROOTS];
}

function isNodeExecutable(candidate: string, policy: AccessProbePolicy): boolean {
  return candidate === canonicalPath(policy.nodeExecutable);
}

function isAllowedRootAncestor(candidate: string, policy: AccessProbePolicy): boolean {
  const roots = [
    policy.installRoot,
    ...(policy.nodeModuleRoots ?? []),
    ...SYSTEM_ROOTS,
    ...SYSTEM_FILES,
  ];
  return roots.some(root => isWithin(root, candidate));
}

function isDeclaredWritableRootAncestor(candidate: string, policy: AccessProbePolicy): boolean {
  return [policy.workspace, policy.cortexHome, policy.logsDir]
    .some(root => isWithin(root, candidate));
}

interface PathDecision {
  offender: string;
  reason: string | null;
}

function pathDecision(reason: string | null, offender: string): PathDecision {
  return { reason, offender };
}

function classifyPath(
  candidate: string, access: AccessMode, syscall: string, policy: AccessProbePolicy, pid: number,
  symlinks: ReadonlyMap<string, string>, followFinal: boolean,
): PathDecision {
  const traced = resolveKnownSymlinks(candidate, symlinks, followFinal);
  const canonical = canonicalFsPath(traced, followFinal);
  if (isWithin(candidate, policy.hostCortexHome)) return pathDecision('host_cortex_path', candidate);
  if (isWithin(canonical, policy.hostCortexHome)) return pathDecision('host_cortex_path',
    traced === candidate ? candidate : canonical);
  if (isNodeExecutable(canonical, policy) && access === 'read') return pathDecision(null, candidate);
  if (isHostDotfile(candidate, policy)) return pathDecision('host_home_dotfile', candidate);
  if (isHostDotfile(canonical, policy)) return pathDecision('host_home_dotfile',
    traced === candidate ? candidate : canonical);
  if (access === 'read' && PHYSICAL_RESOLUTION_SYSCALLS.has(syscall)
      && isDeclaredWritableRootAncestor(canonical, policy)) {
    return pathDecision(null, candidate);
  }
  const writable = [policy.workspace, policy.cortexHome, policy.logsDir];
  if (writable.some(root => isWithin(canonical, root))) return pathDecision(null, candidate);
  if (isAllowedRootAncestor(canonical, policy) && access === 'read') {
    return pathDecision(null, candidate);
  }
  if ((SYSTEM_FILES.has(candidate)
    || isProcessRuntimePath(candidate, pid, policy.tracedPids)) && access === 'read') {
    return pathDecision(null, candidate);
  }
  const readOnly = readOnlyRoots(policy).some(root => isWithin(canonical, root));
  if (readOnly && access === 'read') return pathDecision(null, candidate);
  return pathDecision(readOnly ? 'read_only_root_write' : 'unclassified_path', candidate);
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
  options: AccessTraceOptions, line: number, raw: string,
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
  call: ParsedCall, options: AccessTraceOptions, line: number, raw: string,
): AccessViolation | null {
  if (call.syscall === 'socket' || call.syscall === 'socketpair') {
    const family = /^AF_[A-Z0-9_]+/.exec(call.args[0] ?? '')?.[0] ?? 'unknown';
    const reason = family === 'AF_INET' || family === 'AF_INET6'
      ? 'network_socket_denied' : 'unclassified_network_socket';
    return violation(call.syscall, family, reason, 'network', options, line, raw);
  }
  const reason = NETWORK_DENIALS[call.syscall];
  if (reason) {
    const endpoint = call.syscall === 'listen'
      ? endpointFromFd(call.args[0])
      : endpointFromSockaddr(call.args);
    return violation(call.syscall, endpoint ?? `fd:${call.args[0] ?? 'unknown'}`, reason,
      'network', options, line, raw);
  }
  const unixMetadata = call.syscall === 'getsockname' || call.syscall === 'getsockopt';
  if (unixMetadata && /^[12]<UNIX-STREAM:/.test(call.args[0] ?? '')) return null;
  return violation(call.syscall, raw, 'unclassified_network_syscall', 'unknown', options, line, raw);
}

function unknownViolation(
  call: ParsedCall | null, options: AccessTraceOptions, line: number, raw: string,
): AccessViolation {
  const syscall = call?.syscall ?? 'trace';
  const offender = call?.args.map(decodeQuoted).find(value => value !== null) ?? raw;
  const reason = call ? 'unclassified_syscall' : 'trace_parse_failed';
  return violation(syscall, offender, reason, 'unknown', options, line, raw);
}

const FD_RETURNING_FILE_CALLS = new Set(['creat', 'open', 'openat', 'openat2']);

function returnedFdPath(call: ParsedCall): string | null {
  if (!FD_RETURNING_FILE_CALLS.has(call.syscall)) return null;
  const match = /^\d+<(.+)>/.exec(call.result);
  if (!match?.[1].startsWith('/')) return null;
  return match[1].replace(/<(?:char|block) [^>]+>$/, '');
}

const NOFOLLOW_FINAL = new Set([
  'lchown', 'link', 'linkat', 'lstat', 'readlink', 'readlinkat', 'rename', 'renameat',
  'renameat2', 'rmdir', 'symlink', 'symlinkat', 'unlink', 'unlinkat',
]);

function followsFinalSymlink(call: ParsedCall): boolean {
  if (NOFOLLOW_FINAL.has(call.syscall)) return false;
  if (call.syscall === 'newfstatat' && call.args.some(arg => arg.includes('AT_SYMLINK_NOFOLLOW'))) {
    return false;
  }
  if (call.syscall.startsWith('open') && call.args.some(arg => arg.includes('O_NOFOLLOW'))) {
    return false;
  }
  return true;
}

function pathViolation(
  call: ParsedCall, candidate: string | null, observed: string | null, access: AccessMode,
  options: AccessTraceOptions, line: number, raw: string, symlinks: ReadonlyMap<string, string>,
): AccessViolation[] {
  if (!candidate) return [violation(call.syscall, raw, 'unclassifiable_path', 'unknown',
    options, line, raw)];
  const followFinal = followsFinalSymlink(call);
  const attempted = classifyPath(
    candidate, access, call.syscall, options.policy, options.pid, symlinks, followFinal,
  );
  if (attempted.reason) return [violation(call.syscall, attempted.offender, attempted.reason,
    access, options, line, raw)];
  if (!observed || canonicalPath(observed) === canonicalPath(candidate, symlinks, followFinal)) return [];
  const actual = classifyPath(
    observed, access, call.syscall, options.policy, options.pid, symlinks, true,
  );
  return actual.reason ? [violation(call.syscall, actual.offender, actual.reason, access,
    options, line, raw)] : [];
}

interface FileClassification {
  operands: Array<string | null>;
  violations: AccessViolation[];
}

function classifyFile(
  call: ParsedCall, state: ProcessState, options: AccessTraceOptions, line: number, raw: string,
  symlinks: ReadonlyMap<string, string>,
): FileClassification {
  const specs = FILE_ARGUMENTS[call.syscall];
  if (!specs) return { violations: [unknownViolation(call, options, line, raw)], operands: [null] };
  const access = accessMode(call);
  const operands = specs.map(spec => resolveTracedPath(
    call.args[spec.pathIndex],
    spec.dirIndex === undefined ? undefined : call.args[spec.dirIndex],
    state,
  ));
  const observed = returnedFdPath(call);
  const violations = operands.flatMap((candidate, index) => pathViolation(
    call, candidate, index === 0 ? observed : null, access, options, line, raw, symlinks,
  ));
  return { violations, operands };
}

function isNetworkCall(call: ParsedCall): boolean {
  return NETWORK_SYSCALLS.has(call.syscall);
}

function isSignalMetadata(body: string): boolean {
  return /^\d+(?:\.\d+)?\s+--- SIG[A-Z0-9]+ /.test(body);
}

function emptyCounts(): AccessProbeCounts {
  return { traceLines: 0, fileCalls: 0, networkCalls: 0, allowed: 0 };
}

function succeeded(call: ParsedCall): boolean {
  return !call.result.startsWith('-1') && call.result !== '?';
}

function returnedNumber(call: ParsedCall): number | null {
  const value = Number.parseInt(call.result, 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function cloneState(state: ProcessState): ProcessState {
  return { cwd: state.cwd, fds: new Map(state.fds) };
}

function moveSymlinks(
  symlinks: Map<string, string>, source: string, destination: string,
): void {
  for (const [entry, target] of [...symlinks]) {
    if (!isWithin(entry, source)) continue;
    symlinks.delete(entry);
    const suffix = path.relative(source, entry);
    symlinks.set(suffix ? path.join(destination, suffix) : destination, target);
  }
}

function unfinishedSyscall(body: string): string | null {
  if (!body.endsWith('<unfinished ...>')) return null;
  const callBody = body.replace(/^\d+(?:\.\d+)?\s+/, '');
  return /^([A-Za-z0-9_]+)\(/.exec(callBody)?.[1] ?? null;
}

function resumedCall(body: string): { syscall: string; suffix: string } | null {
  const callBody = body.replace(/^\d+(?:\.\d+)?\s+/, '');
  const match = /^<\.\.\. ([A-Za-z0-9_]+) resumed>(.*)$/.exec(callBody);
  return match ? { syscall: match[1], suffix: match[2] } : null;
}

export class AccessTraceClassifier {
  private readonly counts = emptyCounts();
  private readonly pending = new Map<number, PendingCall>();
  private readonly processes = new Map<number, ProcessState>();
  private readonly symlinks = new Map<string, string>();
  private readonly violations: AccessViolation[] = [];
  private rootPid: number | null;

  constructor(private readonly options: AccessTraceOptions) {
    this.rootPid = options.pid > 0 ? options.pid : null;
    if (this.rootPid !== null) {
      this.processes.set(this.rootPid, { cwd: path.resolve(options.initialCwd), fds: new Map() });
    }
  }

  private eventOptions(pid: number): AccessTraceOptions {
    return { ...this.options, pid };
  }

  private processState(pid: number): ProcessState {
    const existing = this.processes.get(pid);
    if (existing) return existing;
    const isRoot = this.rootPid === null;
    if (isRoot) this.rootPid = pid;
    const state = {
      cwd: isRoot ? path.resolve(this.options.initialCwd) : null,
      fds: new Map<number, string>(),
    };
    this.processes.set(pid, state);
    const traced = this.options.policy.tracedPids as Set<number> | undefined;
    traced?.add?.(pid);
    return state;
  }

  private inheritProcess(call: ParsedCall, pid: number): boolean {
    if (!PROCESS_METADATA.has(call.syscall)) return false;
    const childPid = returnedNumber(call);
    if (succeeded(call) && childPid !== null
      && ['clone', 'clone3', 'fork', 'vfork'].includes(call.syscall)) {
      this.processes.set(childPid, cloneState(this.processState(pid)));
      const traced = this.options.policy.tracedPids as Set<number> | undefined;
      traced?.add?.(childPid);
    }
    return true;
  }

  private updateSymlinks(call: ParsedCall, operands: Array<string | null>): void {
    if (!succeeded(call)) return;
    const entry = operands[0];
    if ((call.syscall === 'symlink' || call.syscall === 'symlinkat') && entry) {
      const target = decodeQuoted(call.args[0]);
      if (target !== null) this.symlinks.set(canonicalPath(entry, this.symlinks, false), target);
      return;
    }
    if (['unlink', 'unlinkat'].includes(call.syscall) && entry) {
      this.symlinks.delete(canonicalPath(entry, this.symlinks, false));
      return;
    }
    if (call.syscall.startsWith('rename') && entry && operands[1]) {
      moveSymlinks(this.symlinks, canonicalPath(entry, this.symlinks, false),
        canonicalPath(operands[1], this.symlinks, false));
    }
  }

  private updateProcessState(
    call: ParsedCall, state: ProcessState, operands: Array<string | null>,
  ): void {
    if (!succeeded(call)) return;
    if (call.syscall === 'chdir' && operands[0]) {
      state.cwd = canonicalPath(operands[0], this.symlinks);
    }
    const fd = FD_RETURNING_FILE_CALLS.has(call.syscall) ? returnedNumber(call) : null;
    const fdPath = returnedFdPath(call) ?? operands[0];
    if (fd !== null && fdPath) state.fds.set(fd, canonicalPath(fdPath, this.symlinks));
    this.updateSymlinks(call, operands);
  }

  private classifyCall(call: ParsedCall, pid: number, line: number, raw: string): void {
    const options = this.eventOptions(pid);
    if (isNetworkCall(call)) {
      this.counts.networkCalls += 1;
      const denied = classifyNetwork(call, options, line, raw);
      if (denied) this.violations.push(denied);
      else this.counts.allowed += 1;
      return;
    }
    if (this.inheritProcess(call, pid)) return;
    const state = this.processState(pid);
    const result = classifyFile(call, state, options, line, raw, this.symlinks);
    this.counts.fileCalls += result.operands.length;
    this.violations.push(...result.violations);
    this.counts.allowed += Math.max(0, result.operands.length - result.violations.length);
    this.updateProcessState(call, state, result.operands);
  }

  private classifyBody(body: string, pid: number, line: number, raw: string): void {
    const call = parseTraceCall(body);
    if (!call) this.violations.push(unknownViolation(null, this.eventOptions(pid), line, raw));
    else this.classifyCall(call, pid, line, raw);
  }

  private startPending(pid: number, body: string, line: number, raw: string, syscall: string): void {
    const previous = this.pending.get(pid);
    if (previous) this.violations.push(unknownViolation(null, this.eventOptions(pid),
      previous.line, previous.raw));
    this.pending.set(pid, {
      body: body.slice(0, -'<unfinished ...>'.length), line, raw, syscall,
    });
  }

  private finishPending(
    pid: number, resumed: { syscall: string; suffix: string }, line: number, raw: string,
  ): void {
    const pending = this.pending.get(pid);
    this.pending.delete(pid);
    if (!pending || pending.syscall !== resumed.syscall) {
      this.violations.push(unknownViolation(null, this.eventOptions(pid), line, raw));
      return;
    }
    this.classifyBody(`${pending.body}${resumed.suffix}`, pid, pending.line,
      `${pending.raw} ${raw}`);
  }

  consume(raw: string): void {
    if (raw.length === 0) return;
    this.counts.traceLines += 1;
    const line = this.counts.traceLines;
    const { body, pid } = parsePrefix(raw, this.options.pid);
    if (isSignalMetadata(body)) return;
    const unfinished = unfinishedSyscall(body);
    if (unfinished) return this.startPending(pid, body, line, raw, unfinished);
    const resumed = resumedCall(body);
    if (resumed) return this.finishPending(pid, resumed, line, raw);
    this.classifyBody(body, pid, line, raw);
  }

  finish(): TraceClassification {
    for (const [pid, pending] of this.pending) {
      this.violations.push(unknownViolation(null, this.eventOptions(pid),
        pending.line, pending.raw));
    }
    this.pending.clear();
    return { counts: { ...this.counts }, violations: [...this.violations] };
  }
}

export function classifyTraceLines(
  lines: string[], options: AccessTraceOptions,
): TraceClassification {
  const classifier = new AccessTraceClassifier(options);
  lines.forEach(line => classifier.consume(line));
  return classifier.finish();
}

export async function classifyTraceStream(
  input: NodeJS.ReadableStream, options: AccessTraceOptions,
): Promise<TraceClassification> {
  const classifier = new AccessTraceClassifier(options);
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) classifier.consume(line);
  return classifier.finish();
}
