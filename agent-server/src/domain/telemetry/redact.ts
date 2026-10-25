import os from 'node:os';
import { INSTALL_ROOT } from '@core/paths.js';

/** What redaction must recognize on this machine. Injected in tests. */
export interface RedactionContext {
  installRoot: string;
  homeDir: string;
  username: string;
  hostname: string;
}

export const MAX_MESSAGE_CHARS = 300;
export const MAX_STACK_FRAMES = 30;
export const MAX_STACK_CHARS = 8_000;

function safeUsername(): string {
  try { return os.userInfo().username; } catch { return ''; }
}

export function defaultRedactionContext(): RedactionContext {
  return { installRoot: INSTALL_ROOT, homeDir: os.homedir(), username: safeUsername(), hostname: os.hostname() };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Both separator spellings of a directory, longest first, for literal matching. */
function spellings(dir: string): string[] {
  const forward = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  const back = forward.replace(/\//g, '\\');
  return [...new Set([forward, back])].filter((item) => item.length > 1);
}

/** Cortex's own files keep their path relative to the install root (`dist/domain/...`). */
function relativizeInstallRoot(text: string, installRoot: string): string {
  let out = text;
  for (const root of spellings(installRoot)) {
    const pattern = new RegExp(`(?:file:\\/\\/\\/?)?${escapeRegExp(root)}([\\\\/][^\\s:'"()<>]*)`, 'g');
    out = out.replace(pattern, (_match, rest: string) => rest.slice(1).replace(/\\/g, '/'));
  }
  return out;
}

const URL_RE = /\b([a-z][a-z0-9+.-]*):\/\/([^\s/?#'"()<>]*)([^\s?#'"()<>]*)(?:[?#][^\s'"()<>]*)?/gi;
const KEEP_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** URLs keep scheme and path; the host becomes `<host>`, query, fragment and userinfo go. */
function redactUrls(text: string): string {
  return text.replace(URL_RE, (_match, scheme: string, authority: string, pathPart: string) => {
    const host = authority.replace(/^[^@]*@/, '');
    const bare = host.replace(/:\d+$/, '').toLowerCase();
    const keep = scheme.toLowerCase() === 'cortexui' || KEEP_HOSTS.has(bare);
    if (scheme.toLowerCase() === 'file') return '<path>';
    return `${scheme}://${keep ? host : '<host>'}${pathPart}`;
  });
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PREFIXED_KEY_RE = /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abposr]|glpat|AKIA|AIza)[-_A-Za-z0-9]{8,}/g;
const HEX_RE = /\b[0-9a-fA-F]{32,}\b/g;
const B64_RE = /[A-Za-z0-9+_=-]{32,}/g;
const IPV4_RE = /\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)(?:\d{1,3}\.){3}\d{1,3}\b/g;

function redactSecrets(text: string): string {
  return text
    .replace(EMAIL_RE, '<email>')
    .replace(PREFIXED_KEY_RE, '<secret>')
    .replace(HEX_RE, '<secret>')
    .replace(B64_RE, (run) => (/\d/.test(run) && /[A-Za-z]/.test(run) ? '<secret>' : run))
    .replace(IPV4_RE, '<ip>');
}

const POSIX_PATH_RE = /(?<![\w.:/\\<>-])\/(?:[^\s:'"()<>,;]+)/g;
const WINDOWS_PATH_RE = /\b[A-Za-z]:[\\/][^\s:'"()<>,;]*/g;
const UNC_PATH_RE = /\\\\[^\s\\:'"()<>]+\\[^\s:'"()<>,;]*/g;

function redactAbsolutePaths(text: string): string {
  return text.replace(UNC_PATH_RE, '<path>').replace(WINDOWS_PATH_RE, '<path>').replace(POSIX_PATH_RE, '<path>');
}

/** Literal leftovers: the home directory, user name and host name anywhere in the text. */
function redactIdentity(text: string, ctx: RedactionContext): string {
  let out = text;
  for (const home of spellings(ctx.homeDir)) out = out.split(home).join('<home>');
  const names = [[ctx.hostname, '<host>'], [ctx.username, '<user>']] as const;
  // Longest first: a host name often contains the user name.
  for (const [value, label] of [...names].sort((a, b) => b[0].length - a[0].length)) {
    if (value.length < 3) continue;
    out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(value)}(?![A-Za-z0-9])`, 'gi'), label);
  }
  return out;
}

/** Apply every rule. Order matters: Cortex's own paths become relative before any path is cut. */
export function redactText(text: string, ctx: RedactionContext = defaultRedactionContext()): string {
  const relative = relativizeInstallRoot(text, ctx.installRoot);
  return redactIdentity(redactAbsolutePaths(redactSecrets(redactUrls(relative))), ctx);
}

export function redactMessage(text: string, ctx?: RedactionContext): string {
  return redactText(text, ctx).slice(0, MAX_MESSAGE_CHARS);
}

/** Redacted stack: the header line plus at most 30 frames, within the size cap. */
export function redactStack(stack: string, ctx?: RedactionContext): string {
  const lines = redactText(stack, ctx).split('\n');
  const header = lines.findIndex((line) => /^\s*at\s/.test(line));
  const frames = header === -1 ? lines.slice(0, MAX_STACK_FRAMES + 1) : lines.slice(0, header + MAX_STACK_FRAMES);
  return frames.join('\n').slice(0, MAX_STACK_CHARS);
}

const OWN_FRAME_RE = /^\s*at\s+(?:(\S+)\s+)?\(?((?:dist|src)\/[^\s:()]+)/;
const WEB_FRAME_RE = /(?:^|[\s@(])((?:[a-z]+:\/\/[^\s/]+)?\/assets\/[^\s:()]+)/;

/** Grouping key: error name + the first frame in Cortex's own code (function and file). */
export function groupKeyOf(errorName: string, redactedStack: string): string {
  for (const line of redactedStack.split('\n')) {
    const own = OWN_FRAME_RE.exec(line);
    if (own) return `${errorName}@${own[2]}${own[1] ? `#${own[1]}` : ''}`.slice(0, 200);
    const web = WEB_FRAME_RE.exec(line);
    if (web) return `${errorName}@${web[1].replace(/^[a-z]+:\/\/[^/]+/, '')}`.slice(0, 200);
  }
  return `${errorName}@unknown`.slice(0, 200);
}
