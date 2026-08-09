// input:  process argv and the selected public Cortex subcommand
// output: minimal agent-run dispatch or the full operator CLI
// pos:    Package bin bootstrap that isolates standalone agent-run imports
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function runAgentRun(args: string[]): Promise<void> {
  const { runAgentRunCli } = await import('../domain/agent-run/agent-run-cli.js');
  process.exitCode = await runAgentRunCli(args);
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  if (args[0] === 'agent-run') {
    await runAgentRun(args.slice(1));
    return;
  }
  const cli = await import('./cli.js');
  cli.main();
}

function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return fs.realpathSync(invoked) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(invoked) === fileURLToPath(import.meta.url);
  }
}

if (isMainModule()) {
  main().catch((error) => {
    process.stderr.write(`${(error as Error)?.message ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
