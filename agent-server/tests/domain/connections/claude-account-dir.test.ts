import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  claudeAccountDir, ensureClaudeAccountDir, removeClaudeAccountDir,
} from '../../../src/domain/connections/claude-account-dir.js';

let root: string;
let shared: string;
let accountsDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-account-dir-'));
  shared = path.join(root, 'claude');
  accountsDir = path.join(root, 'claude-accounts');
  fs.mkdirSync(path.join(shared, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(shared, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(shared, 'settings.json'), '{"shared":true}');
  fs.writeFileSync(path.join(shared, '.credentials.json'), '{"fake":"default"}');
  fs.writeFileSync(path.join(shared, '.claude.json'), '{"fake":"default"}');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const deps = () => ({ sharedDir: shared, accountsDir });

function linkOf(name: string): string | null {
  const file = path.join(accountsDir, 'school', name);
  return fs.lstatSync(file).isSymbolicLink() ? fs.readlinkSync(file) : null;
}

describe('ensureClaudeAccountDir', () => {
  it('links every shared entry except the login itself', () => {
    const dir = ensureClaudeAccountDir('school', deps());
    expect(dir).toBe(path.join(accountsDir, 'school'));
    expect(fs.readdirSync(dir).sort()).toEqual(['plugins', 'projects', 'settings.json']);
    expect(linkOf('projects')).toBe(path.join(shared, 'projects'));
    expect(linkOf('plugins')).toBe(path.join(shared, 'plugins'));
    expect(linkOf('settings.json')).toBe(path.join(shared, 'settings.json'));
    expect(fs.existsSync(path.join(shared, 'projects'))).toBe(true);
  });

  it('writes through to the shared transcript store', () => {
    const dir = ensureClaudeAccountDir('school', deps());
    fs.mkdirSync(path.join(dir, 'projects', '-cwd'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'projects', '-cwd', 's.jsonl'), '{}\n');
    expect(fs.existsSync(path.join(shared, 'projects', '-cwd', 's.jsonl'))).toBe(true);
  });

  it('is idempotent and picks up new shared entries', () => {
    ensureClaudeAccountDir('school', deps());
    fs.mkdirSync(path.join(shared, 'todos'));
    ensureClaudeAccountDir('school', deps());
    expect(linkOf('todos')).toBe(path.join(shared, 'todos'));
    expect(linkOf('projects')).toBe(path.join(shared, 'projects'));
  });

  it('keeps the account login and a real directory the CLI made', () => {
    const dir = claudeAccountDir('school', deps());
    fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.credentials.json'), '{"fake":"school"}');
    ensureClaudeAccountDir('school', deps());
    expect(linkOf('plugins')).toBeNull();
    expect(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8')).toBe('{"fake":"school"}');
  });

  it('restores settings the CLI replaced, and repoints or prunes stale links', () => {
    const dir = ensureClaudeAccountDir('school', deps());
    fs.rmSync(path.join(dir, 'settings.json'));
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"local":true}');
    fs.symlinkSync(path.join(root, 'gone'), path.join(dir, 'debug'));
    fs.rmSync(path.join(dir, 'plugins'));
    fs.symlinkSync(path.join(root), path.join(dir, 'plugins'));
    ensureClaudeAccountDir('school', deps());
    expect(linkOf('settings.json')).toBe(path.join(shared, 'settings.json'));
    expect(linkOf('plugins')).toBe(path.join(shared, 'plugins'));
    expect(fs.existsSync(path.join(dir, 'debug'))).toBe(false);
  });

  it('refuses an id that is not a connection id', () => {
    expect(() => ensureClaudeAccountDir('../escape', deps())).toThrow(/Invalid account id/);
  });
});

describe('removeClaudeAccountDir', () => {
  it('deletes the account dir and leaves the shared one intact', () => {
    const dir = ensureClaudeAccountDir('school', deps());
    fs.writeFileSync(path.join(shared, 'projects', 'keep.jsonl'), '{}\n');
    fs.writeFileSync(path.join(dir, '.credentials.json'), '{"fake":"school"}');
    removeClaudeAccountDir('school', deps());
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(path.join(shared, 'projects', 'keep.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(shared, 'settings.json'))).toBe(true);
    expect(() => removeClaudeAccountDir('school', deps())).not.toThrow();
  });
});
