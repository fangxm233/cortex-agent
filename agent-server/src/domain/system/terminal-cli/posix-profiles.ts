import * as fs from 'fs';
import * as path from 'path';
import { isChanged, type PathChange, type PathMode, type PathRegistrar } from './registrar.js';

const BEGIN = '# >>> cortex >>>';
const END = '# <<< cortex <<<';
const BLOCK_RE = /# >>> cortex >>>\n[\s\S]*?\n# <<< cortex <<<\n?/;

const shQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export function renderBlock(dir: string): string {
  const q = shQuote(dir);
  return `${BEGIN}\ncase ":\${PATH}:" in *:${q}:*) ;; *) PATH=${q}:"$PATH"; export PATH ;; esac\n${END}\n`;
}

/**
 * Insert or refresh the block. `top` serves ~/.bashrc, whose interactive guard would otherwise skip
 * an appended block for non-interactive `ssh host cortex …`.
 */
export function upsertBlock(content: string, block: string, position: 'top' | 'bottom'): string {
  if (BLOCK_RE.test(content)) return content.replace(BLOCK_RE, () => block);
  if (!content) return block;
  if (position === 'top') return `${block}\n${content}`;
  return `${content}${content.endsWith('\n') ? '' : '\n'}\n${block}`;
}

/** Undo `upsertBlock`, including the blank separator line it added. */
export function removeBlock(content: string): string {
  const match = BLOCK_RE.exec(content);
  if (!match) return content;
  const before = content.slice(0, match.index);
  const after = content.slice(match.index + match[0].length);
  if (before === '') return after.replace(/^\n/, '');
  return (before.endsWith('\n\n') ? before.slice(0, -1) : before) + after;
}

interface ProfileEnv {
  home: string;
  platform: NodeJS.Platform;
  zdotdir?: string;
  exists: (file: string) => boolean;
  hasZsh: boolean;
}

/** rustup's set: ~/.profile always; bash files that exist; ~/.zshenv where zsh is in use. */
export function profileTargets(env: ProfileEnv): Array<{ file: string; position: 'top' | 'bottom' }> {
  const at = (name: string) => path.join(env.home, name);
  const targets: Array<{ file: string; position: 'top' | 'bottom' }> = [{ file: at('.profile'), position: 'bottom' }];
  if (env.exists(at('.bashrc'))) targets.push({ file: at('.bashrc'), position: 'top' });
  if (env.exists(at('.bash_profile'))) targets.push({ file: at('.bash_profile'), position: 'bottom' });
  const zdot = env.zdotdir || env.home;
  const usesZsh = env.platform === 'darwin' || env.hasZsh || env.exists(path.join(zdot, '.zshrc'));
  if (usesZsh) targets.push({ file: path.join(zdot, '.zshenv'), position: 'bottom' });
  return targets;
}

function readOrNull(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function planOne(file: string, position: 'top' | 'bottom', dir: string, mode: PathMode): PathChange {
  const before = readOrNull(file);
  if (mode === 'remove') return { target: file, before, after: before === null ? null : removeBlock(before) };
  return { target: file, before, after: upsertBlock(before ?? '', renderBlock(dir), position) };
}

export function posixRegistrar(env: ProfileEnv): PathRegistrar {
  return {
    plan: (dir, mode) => profileTargets(env).map(({ file, position }) => planOne(file, position, dir, mode)),
    apply: (changes) => {
      for (const change of changes.filter(isChanged)) {
        if (change.after !== null) fs.writeFileSync(change.target, change.after);
      }
    },
  };
}
