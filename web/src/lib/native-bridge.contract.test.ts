// The native command contract lives in three hand-kept lists: the shell's `generate_handler!`,
// `NativeCommandMap` here, and the window capability. Tauri answers an unregistered or ungranted
// command with a rejected promise that `safeInvoke` swallows, so drift only shows up as a dead
// button on a device. This test parses all three and keeps them in step.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript-5';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(import.meta.dirname, '../../..');
const DESKTOP = path.join(REPO, 'desktop');
const CORE_PLUGINS = new Set(['app', 'event', 'image', 'menu', 'path', 'resources', 'tray', 'webview', 'window']);

const read = (...parts: string[]) => readFileSync(path.join(...parts), 'utf8');
const permissionName = (command: string) => `allow-${command.replaceAll('_', '-')}`;

function shellCommands(): string[] {
  const source = read(DESKTOP, 'src-tauri/src/lib.rs');
  const body = /generate_handler!\[([^\]]*)\]/.exec(source)?.[1];
  if (!body) throw new Error('generate_handler! not found in lib.rs');
  return body.split(',').map((entry) => entry.replace(/\/\/.*$/gm, '').trim()).filter(Boolean)
    .map((entry) => entry.split('::').at(-1)!);
}

function bridgeCommands(): string[] {
  const file = path.join(import.meta.dirname, 'native-bridge.ts');
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
  const map = source.statements.find((node): node is ts.InterfaceDeclaration =>
    ts.isInterfaceDeclaration(node) && node.name.text === 'NativeCommandMap');
  if (!map) throw new Error('NativeCommandMap not found in native-bridge.ts');
  return map.members.map((member) => {
    const name = member.name;
    if (!name || !(ts.isIdentifier(name) || ts.isStringLiteral(name))) throw new Error('unexpected member');
    return name.text;
  });
}

function pluginDefaults(plugin: string): string[] {
  const toml = read(DESKTOP, `tauri-plugin-${plugin}`, 'permissions/default.toml');
  const list = /\[default\][\s\S]*?permissions\s*=\s*\[([^\]]*)\]/.exec(toml)?.[1] ?? '';
  return [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

const granted: string[] = JSON.parse(read(DESKTOP, 'src-tauri/capabilities/default.json')).permissions;

describe('native command contract', () => {
  const shell = shellCommands();
  const bridge = bridgeCommands();
  const appCommands = bridge.filter((command) => !command.startsWith('plugin:'));

  it('parses every list', () => {
    expect(shell.length).toBeGreaterThan(10);
    expect(appCommands.length).toBeGreaterThan(10);
  });

  it('registers every app command the SPA declares', () => {
    expect(appCommands.filter((command) => !shell.includes(command))).toEqual([]);
  });

  it('declares every registered app command in the SPA', () => {
    expect(shell.filter((command) => !appCommands.includes(command))).toEqual([]);
  });

  it('grants every plugin command the SPA declares', () => {
    const ungranted = bridge.filter((key) => key.startsWith('plugin:')).filter((key) => {
      const [, plugin, command] = /^plugin:([a-z-]+)\|([a-z_]+)$/.exec(key) ?? [];
      if (!plugin || !command) return true;
      const allow = permissionName(command);
      // Core commands carry an explicit grant each, so the capability file lists exactly what the
      // page uses instead of leaning on what `core:default` happens to include.
      if (CORE_PLUGINS.has(plugin)) return !granted.includes(`core:${plugin}:${allow}`);
      if (granted.includes(`${plugin}:${allow}`)) return false;
      return !(granted.includes(`${plugin}:default`) && pluginDefaults(plugin).includes(allow));
    });
    expect(ungranted).toEqual([]);
  });
});
