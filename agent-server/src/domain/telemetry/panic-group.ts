// Group keys for native shell panics. The shell's panic hook formats its message as
// `<text> at <file>:<line>:<col>`; the file is relative for the shell's own crate (`src/setup.rs`) and
// absolute for dependencies and the standard library. Only the source-relative part is kept, so a
// key never carries a home directory, user name or checkout location.

const MESSAGE_LOCATION_RE = / at (\S+):(\d+):\d+\s*$/;
const FRAME_LOCATION_RE = /^\s*at (\S+):(\d+):\d+\s*$/;
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
/** A published crate directory in the cargo registry (`tauri-2.1.0`). */
const CRATE_DIR_RE = /^[A-Za-z0-9_-]+-\d+\.\d+\.\d+[A-Za-z0-9.+-]*$/;
/** A standard library crate under the toolchain's `library/` directory. */
const STD_CRATE_RE = /^(?:core|std|alloc|proc_macro|test)$/;
const MAX_FILE_LENGTH = 120;

function isRelative(file: string): boolean {
  return !/^(?:[A-Za-z]:\/|\/|~)/.test(file);
}

function safePath(file: string): string | null {
  const segments = file.split('/');
  const safe = segments.every((segment) => SAFE_SEGMENT_RE.test(segment) && segment !== '..');
  return safe && file.length <= MAX_FILE_LENGTH ? file : null;
}

/** `src/...` of an absolute path, prefixed with the crate directory when that is public. */
function sourceRelative(file: string): string | null {
  const at = file.lastIndexOf('/src/');
  if (at < 0) return null;
  const parent = file.slice(0, at).split('/').pop() ?? '';
  const publicCrate = CRATE_DIR_RE.test(parent) || (file.includes('/library/') && STD_CRATE_RE.test(parent));
  return publicCrate ? `${parent}/${file.slice(at + 1)}` : file.slice(at + 1);
}

/** The reportable form of a panic location's file, or null when none can be derived safely. */
export function panicFile(raw: string): string | null {
  const file = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  return safePath(isRelative(file) ? file : sourceRelative(file) ?? '');
}

function locationKey(match: RegExpExecArray | null): string | null {
  const file = match ? panicFile(match[1]) : null;
  return file ? `panic@${file}:${match![2]}` : null;
}

/** First backtrace frame in the shell's own crate (a relative path); library frames come first. */
function ownFrameKey(stack: string): string | null {
  for (const line of stack.split('\n')) {
    const match = FRAME_LOCATION_RE.exec(line);
    if (match && isRelative(match[1].replace(/\\/g, '/'))) return locationKey(match);
  }
  return null;
}

/** `panic@<file>:<line>` from the panic message, else from the backtrace, else `panic@unknown`. */
export function panicGroupKey(message: string, stack: string): string {
  return locationKey(MESSAGE_LOCATION_RE.exec(message)) ?? ownFrameKey(stack) ?? 'panic@unknown';
}
