const { isSea } = process.getBuiltinModule('node:sea');

/** Keep the script in one argument: fork IPC and MCP selectors retain their normal positions. */
export function runtimeEntry(script: string, sea: boolean = isSea()): string {
  return sea ? `--entry=${script}` : script;
}

export function runtimeCommand(): string {
  return isSea() ? process.execPath : 'node';
}

export function runtimeCommandLine(args: string[]): string {
  if (!isSea()) return ['node', ...args].join(' ');
  return [process.execPath.replaceAll('\\', '/'), ...args].map(arg => JSON.stringify(arg)).join(' ');
}
