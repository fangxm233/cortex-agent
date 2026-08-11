// input:  PI RPC commands and standalone manager policy environment
// output: deterministic parent, manager, coder and reviewer turns
// pos:    Fake PI provider for packed manager-arm tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import fs from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
if (argv[0] !== '--observation') throw new Error('fake manager PI needs --observation');
const observation = argv[1];
const backendArgs = argv.slice(2);
if (backendArgs.includes('--version')) {
  process.stdout.write('2026.8.3 (pi)\n');
  process.exit(0);
}

function say(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function role(message = '') {
  try {
    const context = JSON.parse(message);
    if (context && typeof context === 'object' && context.taskId && context.children) return 'manager';
  } catch { /* non-manager prompts need not be JSON */ }
  const prompts = backendArgs.map(arg => {
    try { return fs.statSync(arg).isFile() ? fs.readFileSync(arg, 'utf8') : arg; }
    catch { return arg; }
  }).join(' ');
  if (prompts.includes('task-tree manager')) return 'manager';
  if (prompts.includes('code implementer')) return 'coder';
  if (prompts.includes('implementation auditor')) return 'reviewer';
  const guard = JSON.parse(process.env.CORTEX_PI_POLICY_GUARD ?? '{}');
  if (!Object.hasOwn(guard, 'thread-owned')) return 'parent';
  const tools = guard['thread-owned'] ?? [];
  return tools.includes('write') ? 'coder' : 'reviewer';
}

function managerReply(message) {
  const stateFile = `${process.cwd()}/manager-fake-state.json`;
  const state = fs.existsSync(stateFile)
    ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { managerTurns: 0 };
  state.managerTurns += 1;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const qaOn = observation.includes('qa-on');
  if (qaOn && state.managerTurns === 1) {
    return JSON.stringify({ actions: [{ type: 'ask', question: 'select trial path' }] });
  }
  if (qaOn && state.managerTurns === 2 && !message.includes('trial parent answer')) {
    throw new Error('manager resumed without the typed parent answer');
  }
  if (state.managerTurns === (qaOn ? 2 : 1)) {
    return JSON.stringify({ actions: [{ type: 'decompose', subtasks: [{
      key: 'leaf', text: 'public leaf', done_when: 'leaf accepted',
      template: 'benchmark-coder-review',
    }] }, { type: 'wait' }] });
  }
  const tasks = JSON.parse(fs.readFileSync(
    `${process.env.CORTEX_HOME}/state/tasks.json`, 'utf8',
  ));
  const child = Object.values(tasks).find(task => task.parent === 'root');
  return JSON.stringify({ actions: [
    { type: 'accept', task_id: child.id, note: 'verified' },
    { type: 'complete', note: 'public root complete' },
  ] });
}

function reply(message) {
  const selected = role(message);
  if (selected === 'manager') return managerReply(message);
  if (selected === 'reviewer') return 'verified. [IMPL-APPROVED]';
  if (selected === 'coder') return 'implemented public leaf';
  return message.includes('manager_parent_question') ? 'trial parent answer' : 'direct parent ready';
}

function recordRole(message) {
  const records = fs.existsSync(observation)
    ? JSON.parse(fs.readFileSync(observation, 'utf8')) : [];
  records.push({ role: role(message), cwd: process.cwd(), args: backendArgs });
  fs.writeFileSync(observation, JSON.stringify(records));
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'get_state') {
    say({ type: 'response', id: command.id, command: 'get_state', success: true,
      data: { sessionId: 'manager-pi-session' } });
    return;
  }
  if (command.type === 'get_session_stats') {
    say({ type: 'response', id: command.id, command: 'get_session_stats', success: true,
      data: { contextUsage: { contextWindow: 200000, tokens: 100, percent: 0.05 } } });
    return;
  }
  if (command.type !== 'prompt') return;
  const message = String(command.message ?? '');
  recordRole(message);
  const text = reply(message);
  say({ type: 'message_update', message: { id: 'manager-pi-message' },
    assistantMessageEvent: { type: 'text_delta', delta: text } });
  say({ type: 'agent_end', messages: [{ role: 'assistant', provider: 'anthropic',
    model: 'fake-manager-pi', usage: { input: 3, output: 2, cost: { total: 0 } } }] });
  say({ type: 'agent_settled' });
});
lines.on('close', () => process.exit(0));
