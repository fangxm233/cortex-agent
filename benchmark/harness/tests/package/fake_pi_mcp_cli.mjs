// input:  PI RPC commands, installed extension paths, benchmark policy env
// output: strict MCP registration observation and one fake PI turn
// pos:    Installed-form PI parent fixture for the Harbor package test
// >>> If I am updated, update my header and folder CORTEX.md <<<

import fs from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('2026.8.3 (pi)\n');
  process.exit(0);
}
const extensions = argv.flatMap((value, index) => (
  value === '--extension' ? [argv[index + 1]] : []
));
const bridgePath = extensions.find(value => value.endsWith('/mcp-bridge.js'));
if (!bridgePath) throw new Error('installed PI spawn omitted mcp-bridge.js');
const handlers = new Map();
const registered = [];
const pi = {
  on(event, handler) { handlers.set(event, handler); },
  registerTool(tool) { registered.push(tool.name); },
};
const bridge = await import(pathToFileURL(bridgePath).href);
await bridge.default(pi);
await handlers.get('before_agent_start')?.({}, {});
const policyPath = process.env.CORTEX_BENCHMARK_THREAD_POLICY_PATH;
fs.writeFileSync('/app/pi-mcp-observation.json', JSON.stringify({
  bridgePath,
  policyPath: policyPath ?? null,
  policyWritableBits: policyPath && fs.existsSync(policyPath)
    ? fs.statSync(policyPath).mode & 0o222 : null,
  registered,
}));

function say(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function respond(command) {
  if (command.type === 'get_state') {
    say({
      type: 'response', id: command.id, command: 'get_state', success: true,
      data: { sessionId: 'installed-pi-session' },
    });
    return;
  }
  if (command.type === 'get_session_stats') {
    say({
      type: 'response', id: command.id, command: 'get_session_stats', success: true,
      data: { contextUsage: { contextWindow: 200000, tokens: 100, percent: 0.05 } },
    });
    return;
  }
  if (command.type !== 'prompt') return;
  say({
    type: 'message_update', message: { id: 'msg-1' },
    assistantMessageEvent: { type: 'text_delta', delta: 'strict server loaded' },
  });
  say({
    type: 'agent_end', messages: [{
      role: 'assistant', provider: 'anthropic', model: 'installed-pi',
      usage: { input: 10, output: 2, cost: { total: 0 } },
    }],
  });
  say({ type: 'agent_settled' });
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  try { respond(JSON.parse(line)); } catch { /* ignore non-RPC input */ }
});
lines.on('close', async () => {
  await handlers.get('session_shutdown')?.({}, {});
  process.exit(0);
});
