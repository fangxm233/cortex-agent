// input:  WebSocket commands, cortex-client config
// output: Remote command results and cortex-run callbacks
// pos:    Standalone cortex-client daemon entry point
// >>> If I am updated, update my header comment and parent CORTEX.md <<<
import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync, spawn } from 'child_process';
import { scanCortexMDChain, type CortexMDEntry } from './cortex-md-scanner.js';
import { createLogger } from './log.js';
import { CONFIG_DIR } from './paths.js';
import { resolveClientToken, buildClientHeaders } from './auth-headers.js';
import { resolveServerUrl } from './server-url.js';
import {
  handleCortexRunLaunch,
  handleCortexRunCancel,
  flushPendingCallbacks,
  findRunDirByCallbackId,
  tryUnlink,
} from './cortex-run-launch.js';

const log = createLogger('cortex-client');

// --- Help (must run before loadConfig() to avoid spurious config errors) ---

function getClientHelp(): string {
  return [
    'cortex-client — remote worker that connects to the Cortex agent server',
    '',
    'Usage: cortex-client',
    '',
    'cortex-client is a daemon-style worker. Configuration is read from',
    `  ${path.join(CONFIG_DIR, 'cortex-client.json')}`,
    'which the agent-server writes during `cortex client-deploy`. There are',
    'no command-line flags beyond --help.',
    '',
    'Config schema (JSON):',
    '  {',
    '    "serverHost": "<agent-server host or LAN IP>",',
    '    "serverPort": 3002,',
    '    "deviceName": "<short device name>"',
    '  }',
    '',
    'Behavior:',
    '  • Opens a WebSocket to ws://<serverHost>:<serverPort> on start.',
    '  • Receives bash/read/write/edit/glob/grep + cortex-run.* commands.',
    '  • Exits if the server rejects the handshake (e.g. device already connected).',
    '  • Reconnects automatically on transient disconnects.',
    '',
    'Options:',
    '  --help, -h    Show this help',
  ].join('\n');
}

if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
  process.stdout.write(`${getClientHelp()}\n`);
  process.exit(0);
}

// --- Config (read from cortex-client.json) ---

interface ClientConfig {
  serverHost: string;
  serverPort: number;
  serverUrl: string;
  deviceName: string;
  clientToken: string;
}

function loadConfig(): ClientConfig {
  const configPath = path.join(CONFIG_DIR, 'cortex-client.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const cfg = JSON.parse(raw);
    // serverHost is optional when a full serverUrl (or CORTEX_SERVER_URL) is given —
    // the tunnel route (wss://...) carries host implicitly.
    if (!cfg.serverHost && !cfg.serverUrl && !process.env.CORTEX_SERVER_URL) {
      throw new Error('Missing serverHost (or provide serverUrl / CORTEX_SERVER_URL)');
    }
    return {
      serverHost: cfg.serverHost,
      serverPort: cfg.serverPort || 3002,
      // Full WS URL (tunnel route). env CORTEX_SERVER_URL > config serverUrl > ws://host:port.
      serverUrl: resolveServerUrl(cfg, process.env),
      deviceName: cfg.deviceName || os.hostname(),
      // WS bearer token required by the agent-server gate; env overrides config (see auth-headers.ts).
      clientToken: resolveClientToken(cfg, process.env),
    };
  } catch (err) {
    log.error(`Failed to load config from ${configPath}: ${(err as Error).message}`);
    log.error('Expected format: {"serverHost":"...","serverPort":3002,"deviceName":"..."} or {"serverUrl":"wss://...","deviceName":"..."}');
    process.exit(1);
  }
}

const CONFIG = loadConfig();
const SERVER_URL = CONFIG.serverUrl;
const DEVICE_NAME = CONFIG.deviceName;
const CLIENT_TOKEN = CONFIG.clientToken;
const PLATFORM = process.platform;
const HEARTBEAT_INTERVAL_MS = 5000;

const GIT_BASH_PATHS = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
];

// --- Output accumulator (prevents WS message size explosion) ---

class OutputAccumulator {
  private head = '';
  private headFull = false;
  private tail = '';
  private totalChars = 0;
  private readonly headSize: number;
  private readonly tailSize: number;

  constructor(maxBytes: number) {
    this.headSize = Math.floor(maxBytes * 0.6);
    this.tailSize = Math.floor(maxBytes * 0.4);
  }

  append(data: string): void {
    this.totalChars += data.length;
    if (!this.headFull) {
      this.head += data;
      if (this.head.length > this.headSize) {
        const overflow = this.head.slice(this.headSize);
        this.head = this.head.slice(0, this.headSize);
        this.headFull = true;
        this.tail = overflow;
      }
    } else {
      this.tail += data;
      if (this.tail.length > this.tailSize * 2) {
        this.tail = this.tail.slice(-this.tailSize);
      }
    }
  }

  toString(): string {
    if (!this.headFull) return this.head;
    const finalTail = this.tail.slice(-this.tailSize);
    const omitted = this.totalChars - this.head.length - finalTail.length;
    return `${this.head}\n\n[... ${omitted} chars truncated ...]\n\n${finalTail}`;
  }
}

// --- Utility functions ---

function detectEncoding(buffer: Buffer): BufferEncoding {
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) return 'utf16le';
  return 'utf8';
}

function detectLineEnding(content: string): '\r\n' | '\n' {
  const crlfCount = (content.match(/\r\n/g) || []).length;
  const lfOnly = content.replace(/\r\n/g, '').match(/\n/g);
  const lfCount = lfOnly ? lfOnly.length : 0;
  return crlfCount > lfCount ? '\r\n' : '\n';
}

function countWords(text: string): number {
  let count = 0;
  const english = text.match(/[a-zA-Z]+/g);
  if (english) count += english.length;
  const cjk = text.match(/[一-鿿㐀-䶿豈-﫿]/g);
  if (cjk) count += cjk.length;
  return count;
}

// --- Image detection ---

const IMAGE_SIGNATURES: Array<{ bytes: number[]; mimeType: string }> = [
  { bytes: [0xFF, 0xD8, 0xFF],             mimeType: 'image/jpeg' },
  { bytes: [0x89, 0x50, 0x4E, 0x47],       mimeType: 'image/png' },
  { bytes: [0x47, 0x49, 0x46, 0x38],       mimeType: 'image/gif' },
  { bytes: [0x52, 0x49, 0x46, 0x46],       mimeType: 'image/webp' },
  { bytes: [0x42, 0x4D],                   mimeType: 'image/bmp' },
];

function detectImageType(buffer: Buffer): string | null {
  for (const sig of IMAGE_SIGNATURES) {
    if (buffer.length < sig.bytes.length) continue;
    if (!sig.bytes.every((b, i) => buffer[i] === b)) continue;
    if (sig.mimeType === 'image/webp') {
      if (buffer.length >= 12 && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
        return 'image/webp';
      }
      continue;
    }
    return sig.mimeType;
  }
  return null;
}

function extractImageDimensions(buf: Buffer, mime: string): { width: number; height: number } | null {
  try {
    if (mime === 'image/png' && buf.length >= 24) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === 'image/gif' && buf.length >= 10) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mime === 'image/bmp' && buf.length >= 26) {
      return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
    }
    if (mime === 'image/webp' && buf.length >= 30) {
      if (buf.slice(12, 16).toString('ascii') === 'VP8 ' && buf.length >= 30) {
        return { width: buf.readUInt16LE(26) & 0x3FFF, height: buf.readUInt16LE(28) & 0x3FFF };
      }
      if (buf.slice(12, 17).toString('ascii') === 'VP8L' && buf.length >= 25) {
        const bits = buf.readUInt32LE(21);
        return { width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 };
      }
    }
    if (mime === 'image/jpeg') {
      let offset = 2;
      while (offset < buf.length - 9) {
        if (buf[offset] !== 0xFF) break;
        const marker = buf[offset + 1];
        if (marker === 0xC0 || marker === 0xC2) {
          return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) };
        }
        const segLen = buf.readUInt16BE(offset + 2);
        offset += 2 + segLen;
      }
    }
  } catch {}
  return null;
}

// --- Capabilities detection ---

function detectCapabilities(): string[] {
  const caps: string[] = [];
  try {
    execFileSync('rg', ['--version'], { timeout: 5000, stdio: 'pipe' });
    caps.push('rg');
  } catch {}
  return caps;
}

// --- Shell execution ---

function findGitBash(): string | null {
  for (const p of GIT_BASH_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function spawnCommand(
  cmd: string,
  args: string[],
  timeout: number,
  maxOutputBytes = 500_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const stdoutAcc = new OutputAccumulator(maxOutputBytes);
    const stderrAcc = new OutputAccumulator(50_000);

    proc.stdout.on('data', (d: Buffer) => stdoutAcc.append(d.toString()));
    proc.stderr.on('data', (d: Buffer) => stderrAcc.append(d.toString()));

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout: stdoutAcc.toString(), stderr: stderrAcc.toString(), exitCode: code ?? 1 });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout: stdoutAcc.toString(), stderr: stderrAcc.toString() + '\n' + err.message, exitCode: 127 });
    });
  });
}

function execBash(command: string, timeout: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const shell = PLATFORM === 'win32' ? findGitBash() : '/bin/bash';
  if (!shell) {
    return Promise.resolve({ stdout: '', stderr: 'bash not found (git-bash not installed on Windows?)', exitCode: 127 });
  }
  return spawnCommand(shell, ['-l', '-c', command], timeout, 200_000);
}

function execBashBackground(command: string): { pid: number | undefined } {
  const shell = PLATFORM === 'win32' ? findGitBash() : '/bin/bash';
  if (!shell) return { pid: undefined };
  const proc = spawn(shell, ['-l', '-c', command], {
    stdio: 'ignore',
    detached: true,
    env: { ...process.env },
  });
  proc.unref();
  return { pid: proc.pid };
}

// --- Tool: Read ---

const MAX_READ_WORDS = 25_000;
const DEFAULT_READ_LINES = 2000;
const MAX_READ_FILE_SIZE = 10 * 1024 * 1024; // 10MB

function normalizePath(p: string): string {
  if (PLATFORM !== 'win32') return p;
  const m = p.match(/^\/([A-Za-z])\/(.*)/);
  if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
  return p;
}

function safeScanCortexMDs(filePath: string): CortexMDEntry[] {
  try {
    return scanCortexMDChain(filePath);
  } catch {
    return [];
  }
}

function handleRead(params: any): { content?: string; error?: string; image?: { data: string; mimeType: string; width?: number; height?: number; originalSize: number }; pdf?: { data: string; originalSize: number }; cortexMDs?: CortexMDEntry[] } {
  try {
    const filePath = normalizePath(params.file_path);
    if (!path.isAbsolute(filePath)) {
      return { error: 'file_path must be absolute' };
    }
    if (!fs.existsSync(filePath)) {
      return { error: `File not found: ${filePath}` };
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return { error: `Not a file: ${filePath}` };
    }
    if (stat.size > MAX_READ_FILE_SIZE) {
      return { error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB, max 10MB). Use offset and limit for range reading.` };
    }

    const rawBuf = fs.readFileSync(filePath);

    const cortexMDs = safeScanCortexMDs(filePath);

    const imageType = detectImageType(rawBuf);
    if (imageType) {
      const dims = extractImageDimensions(rawBuf, imageType);
      return {
        image: {
          data: rawBuf.toString('base64'),
          mimeType: imageType,
          ...(dims ? { width: dims.width, height: dims.height } : {}),
          originalSize: rawBuf.length,
        },
        cortexMDs,
      };
    }

    if (rawBuf.length >= 4 && rawBuf[0] === 0x25 && rawBuf[1] === 0x50 && rawBuf[2] === 0x44 && rawBuf[3] === 0x46) {
      return { pdf: { data: rawBuf.toString('base64'), originalSize: rawBuf.length }, cortexMDs };
    }

    const encoding = detectEncoding(rawBuf);
    const content = rawBuf.toString(encoding);
    const lines = content.split('\n');

    const offset = params.offset || 0;
    const limit = params.limit || DEFAULT_READ_LINES;
    const sliced = lines.slice(offset, offset + limit);
    const numbered = sliced.map((line: string, i: number) => `${offset + i + 1}\t${line}`).join('\n');

    const wordCount = countWords(numbered);
    if (wordCount > MAX_READ_WORDS) {
      const suggestedLimit = Math.max(1, Math.floor(limit * (MAX_READ_WORDS / wordCount) * 0.9));
      return {
        error: `File content too large (~${wordCount} words, limit is ${MAX_READ_WORDS}). ` +
               `Use offset and limit for range reading. Total lines: ${lines.length}. ` +
               `Suggested: limit=${suggestedLimit} to stay within bounds.`,
      };
    }

    return { content: numbered, cortexMDs };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

// --- Tool: Write ---

interface FileMutationResult {
  success?: boolean;
  error?: string;
  cortexMDs?: CortexMDEntry[];
}

function handleWrite(params: any): FileMutationResult {
  try {
    const filePath = normalizePath(params.file_path);
    if (!path.isAbsolute(filePath)) {
      return { error: 'file_path must be absolute' };
    }

    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });

    let content: string = params.content;

    if (fs.existsSync(filePath)) {
      try {
        const existing = fs.readFileSync(filePath, 'utf8');
        const lineEnding = detectLineEnding(existing);
        if (lineEnding === '\r\n') {
          content = content.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
        }
      } catch {}
    }

    fs.writeFileSync(filePath, content, 'utf8');
    return {
      success: true,
      cortexMDs: safeScanCortexMDs(filePath),
    };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

// --- Tool: Edit ---

function handleEdit(params: any): FileMutationResult {
  try {
    const filePath = normalizePath(params.file_path);
    if (!path.isAbsolute(filePath)) {
      return { error: 'file_path must be absolute' };
    }

    const rawBuf = fs.readFileSync(filePath);
    const encoding = detectEncoding(rawBuf);
    const rawContent = rawBuf.toString(encoding);
    const originalLineEnding = detectLineEnding(rawContent);

    const content = rawContent.replace(/\r\n/g, '\n');
    const oldStr = (params.old_string || '').replace(/\r\n/g, '\n');
    const newStr = (params.new_string || '').replace(/\r\n/g, '\n');

    if (!oldStr) {
      return { error: 'old_string is required' };
    }

    const buildResult = (): FileMutationResult => ({
      success: true,
      cortexMDs: safeScanCortexMDs(filePath),
    });

    if (params.replace_all) {
      if (!content.includes(oldStr)) {
        return { error: 'old_string not found in file' };
      }
      const result = content.split(oldStr).join(newStr);
      const final = originalLineEnding === '\r\n' ? result.replace(/\n/g, '\r\n') : result;
      fs.writeFileSync(filePath, final, encoding);
      return buildResult();
    }

    const firstIdx = content.indexOf(oldStr);
    if (firstIdx === -1) {
      return { error: 'old_string not found in file' };
    }
    const secondIdx = content.indexOf(oldStr, firstIdx + 1);
    if (secondIdx !== -1) {
      return { error: 'old_string is not unique in file (found at least 2 occurrences). Provide more context to make it unique, or use replace_all.' };
    }

    const result = content.replace(oldStr, () => newStr);
    const final = originalLineEnding === '\r\n' ? result.replace(/\n/g, '\r\n') : result;
    fs.writeFileSync(filePath, final, encoding);
    return buildResult();
  } catch (err) {
    return { error: (err as Error).message };
  }
}

// --- Tool: Glob ---

const GLOB_MAX_RESULTS = 500;
const VCS_DIRS = new Set(['.git', '.svn', '.hg', 'node_modules', '__pycache__', '.tox', '.mypy_cache']);

async function handleGlob(params: any): Promise<{ files?: string[]; truncated?: boolean; error?: string }> {
  try {
    const pattern = params.pattern;
    const cwd = normalizePath(params.path || (PLATFORM === 'win32' ? 'C:\\' : process.cwd()));

    if (!fs.existsSync(cwd)) {
      return { error: `Directory not found: ${cwd}` };
    }

    const limit = GLOB_MAX_RESULTS + 1;
    const result = await spawnCommand('bash', [
      '-c',
      `shopt -s globstar nullglob 2>/dev/null; cd -- "$1" 2>/dev/null || exit 1; i=0; for f in $2; do echo "$f"; i=$((i+1)); [ $i -ge ${limit} ] && break; done`,
      '--',
      cwd,
      pattern,
    ], 30000);

    if (result.exitCode !== 0 && !result.stdout.trim()) {
      return { files: [], truncated: false };
    }

    let files = result.stdout.trim().split('\n').filter(Boolean);
    const truncated = files.length > GLOB_MAX_RESULTS;
    if (truncated) files = files.slice(0, GLOB_MAX_RESULTS);

    files = files.map(f => path.isAbsolute(f) ? f : path.resolve(cwd, f));

    files = files.filter(f => {
      const parts = path.relative(cwd, f).split(path.sep);
      return !parts.some(p => VCS_DIRS.has(p));
    });

    return { files, truncated };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

// --- Tool: Grep ---

const GREP_VCS_EXCLUDES = ['.git', '.svn', '.hg', 'node_modules', '__pycache__'];

function buildRgArgs(params: any): string[] {
  const args: string[] = [];
  const mode = params.output_mode || 'files_with_matches';

  if (mode === 'files_with_matches') {
    args.push('-l');
  } else if (mode === 'count') {
    args.push('-c');
  } else {
    if (params['-n'] !== false) args.push('-n');
    if (params['-A'] != null) args.push('-A', String(params['-A']));
    if (params['-B'] != null) args.push('-B', String(params['-B']));
    const ctx = params['-C'] ?? params.context;
    if (ctx != null) args.push('-C', String(ctx));
  }

  if (params['-i']) args.push('-i');
  if (params.multiline) args.push('-U', '--multiline-dotall');
  if (params.glob) args.push('--glob', params.glob);
  if (params.type) args.push('--type', params.type);

  for (const dir of GREP_VCS_EXCLUDES) {
    args.push('--glob', `!${dir}`);
  }

  args.push('--max-columns', '500');
  args.push('--', params.pattern);

  if (params.path) args.push(normalizePath(params.path));

  return args;
}

async function handleGrepFallback(params: any): Promise<{ output: string }> {
  const args: string[] = ['-rn'];
  const mode = params.output_mode || 'files_with_matches';

  if (mode === 'files_with_matches') args.push('-l');
  else if (mode === 'count') args.push('-c');
  if (params['-i']) args.push('-i');

  args.push('--', params.pattern);
  args.push(normalizePath(params.path || '.'));

  const result = await spawnCommand('grep', args, 30000);
  return { output: result.stdout };
}

async function handleGrep(params: any): Promise<{ output?: string; error?: string }> {
  try {
    const rgArgs = buildRgArgs(params);
    const result = await spawnCommand('rg', rgArgs, 30000);

    if (result.exitCode === 127 || result.stderr.includes('not found')) {
      return handleGrepFallback(params);
    }

    if (result.exitCode === 2) {
      return { error: result.stderr.trim() || 'grep search error' };
    }

    let output = result.stdout;

    const headLimit = params.head_limit === 0 ? Infinity : (params.head_limit ?? 250);
    const offset = params.offset ?? 0;

    if (output && (offset > 0 || headLimit < Infinity)) {
      const lines = output.split('\n');
      const sliced = lines.slice(offset, offset + headLimit);
      const remaining = lines.length - offset - sliced.length;
      output = sliced.join('\n');
      if (remaining > 0) {
        output += `\n[... ${remaining} more entries, use offset to paginate]`;
      }
    }

    return { output: output || '' };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

// --- Command dispatcher ---

async function handleCommand(action: string, params: any): Promise<{ success: boolean; data?: any; error?: string }> {
  switch (action) {
    case 'bash': {
      const timeout = Math.min(params.timeout || 120000, 600000);
      if (params.run_in_background) {
        const { pid } = execBashBackground(params.command);
        return {
          success: true,
          data: { stdout: `Background process started with PID ${pid}`, stderr: '', exitCode: 0 },
        };
      }
      const result = await execBash(params.command, timeout);
      return { success: true, data: result };
    }
    case 'read': {
      const result = handleRead(params);
      if (result.error) return { success: false, error: result.error };
      return { success: true, data: result };
    }
    case 'write': {
      const result = handleWrite(params);
      if (result.error) return { success: false, error: result.error };
      return { success: true, data: result };
    }
    case 'edit': {
      const result = handleEdit(params);
      if (result.error) return { success: false, error: result.error };
      return { success: true, data: result };
    }
    case 'glob': {
      const result = await handleGlob(params);
      if (result.error) return { success: false, error: result.error };
      return { success: true, data: result };
    }
    case 'grep': {
      const result = await handleGrep(params);
      if (result.error) return { success: false, error: result.error };
      return { success: true, data: result };
    }
    case 'cortex-run.launch': {
      const result = await handleCortexRunLaunch(params, DEVICE_NAME);
      return { success: true, data: result };
    }
    case 'cortex-run.cancel': {
      const result = await handleCortexRunCancel(params);
      return { success: true, data: result };
    }
    default:
      return { success: false, error: `Unknown action: ${action}` };
  }
}

// --- WebSocket connection ---

let ws: WebSocket | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;

function connect() {
  const url = SERVER_URL;
  const headers = buildClientHeaders(CLIENT_TOKEN);
  log.info(`Connecting to ${url} as "${DEVICE_NAME}" (${PLATFORM})${headers ? ' [token]' : ' [no-token]'}...`);

  ws = headers ? new WebSocket(url, { headers }) : new WebSocket(url);

  ws.on('open', () => {
    log.info(`Connected to server`);
    reconnectDelay = 1000;

    const capabilities = detectCapabilities();
    ws!.send(JSON.stringify({
      type: 'hello',
      device: DEVICE_NAME,
      platform: PLATFORM,
      capabilities,
    }));

    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'heartbeat',
          device: DEVICE_NAME,
          timestamp: Date.now(),
        }));
      }
    }, HEARTBEAT_INTERVAL_MS);

    // Flush any pending cortex-run callbacks on connect (DR-0011 §4.7)
    flushPendingCallbacks(ws!, DEVICE_NAME);
    if (flushTimer) clearInterval(flushTimer);
    flushTimer = setInterval(() => flushPendingCallbacks(ws!, DEVICE_NAME), 60_000);
  });

  ws.on('message', async (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'command' && msg.commandId) {
      const currentWs = ws;
      log.info(`Executing ${msg.action}: ${JSON.stringify(msg.params).substring(0, 100)}`);
      try {
        const result = await handleCommand(msg.action, msg.params || {});
        if (currentWs && currentWs.readyState === WebSocket.OPEN) {
          currentWs.send(JSON.stringify({
            type: 'result',
            commandId: msg.commandId,
            ...result,
          }));
        }
      } catch (err) {
        if (currentWs && currentWs.readyState === WebSocket.OPEN) {
          currentWs.send(JSON.stringify({
            type: 'result',
            commandId: msg.commandId,
            success: false,
            error: (err as Error).message,
          }));
        }
      }
    }

    // task-callback-ack: server confirmed receipt, remove pending marker (DR-0011 §4.7)
    if (msg.type === 'task-callback-ack') {
      if (msg.ok) {
        const dir = findRunDirByCallbackId(msg.callbackId);
        if (dir) tryUnlink(path.join(dir, 'callback.pending'));
      } else {
        log.warn(`task-callback rejected: ${msg.callbackId}: ${msg.message}`);
        // Leave marker for retry on next cycle
      }
    }
  });

  ws.on('close', (code, reason) => {
    log.info(`Disconnected (code=${code}, reason=${reason?.toString() || 'none'})`);
    cleanup();
    if (code === 4002) {
      log.info('Server rejected connection (device already connected). Exiting.');
      process.exit(1);
    }
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    log.error(`WebSocket error: ${err.message}`);
  });
}

function cleanup() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  ws = null;
}

function scheduleReconnect() {
  log.info(`Reconnecting in ${reconnectDelay / 1000}s...`);
  setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    connect();
  }, reconnectDelay);
}

// --- Graceful shutdown ---

function shutdown() {
  log.info('Shutting down...');
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (flushTimer) clearInterval(flushTimer);
  if (ws) {
    try { ws.close(1000, 'Client shutting down'); } catch {}
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- Start ---

log.info(`Starting: device="${DEVICE_NAME}", platform="${PLATFORM}", server=${SERVER_URL}`);
connect();
