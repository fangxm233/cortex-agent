import { spawnSync } from 'child_process';
import * as path from 'path';
import { isChanged, type PathChange, type PathMode, type PathRegistrar } from './registrar.js';

export const USER_PATH_TARGET = 'HKCU\\Environment\\Path';

const entryKey = (entry: string) => path.win32.normalize(entry.trim()).replace(/\\+$/, '').toLowerCase();

const matches = (entry: string, dir: string) => entry.trim() !== '' && entryKey(entry) === entryKey(dir);

/** Prepend `dir` unless an equivalent entry exists; `null` means the value is absent. */
export function addUserPathEntry(raw: string | null, dir: string): string {
  if (!raw) return dir;
  if (raw.split(';').some((entry) => matches(entry, dir))) return raw;
  return `${dir};${raw}`;
}

/** Drop `dir`, leaving every other byte of the value as it was. */
export function removeUserPathEntry(raw: string | null, dir: string): string | null {
  if (raw === null) return null;
  const entries = raw.split(';');
  const kept = entries.filter((entry) => !matches(entry, dir));
  return kept.length === entries.length ? raw : kept.join(';');
}

// Read and write the raw (unexpanded) value and keep its registry kind, so `%USERPROFILE%`-style
// entries survive; then broadcast WM_SETTINGCHANGE so new terminals pick the change up.
const READ_SCRIPT = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
if ($k -and ($k.GetValueNames() -contains 'Path')) { [Console]::Out.Write('=' + $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames')) }`;

const WRITE_SCRIPT = `
$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
$kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
if ($k.GetValueNames() -contains 'Path') { $kind = $k.GetValueKind('Path') }
if ($env:CORTEX_USER_PATH) { $k.SetValue('Path', $env:CORTEX_USER_PATH, $kind) } else { $k.DeleteValue('Path', $false) }
Add-Type -Namespace CortexEnv -Name Native -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);'
$r = [UIntPtr]::Zero
[void][CortexEnv.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)`;

function powershell(script: string, extraEnv: Record<string, string> = {}): string {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0) throw new Error(`powershell failed: ${(result.stderr || String(result.error ?? '')).trim()}`);
  return result.stdout;
}

/** Null when the user Path value does not exist. */
export function readUserPath(): string | null {
  const out = powershell(READ_SCRIPT);
  return out.startsWith('=') ? out.slice(1) : null;
}

export function writeUserPath(value: string | null): void {
  powershell(WRITE_SCRIPT, { CORTEX_USER_PATH: value ?? '' });
}

export function windowsRegistrar(io = { read: readUserPath, write: writeUserPath }): PathRegistrar {
  return {
    plan: (dir: string, mode: PathMode): PathChange[] => {
      const before = io.read();
      const after = mode === 'add' ? addUserPathEntry(before, dir) : removeUserPathEntry(before, dir);
      return [{ target: USER_PATH_TARGET, before, after }];
    },
    apply: (changes) => {
      for (const change of changes.filter(isChanged)) io.write(change.after);
    },
  };
}
