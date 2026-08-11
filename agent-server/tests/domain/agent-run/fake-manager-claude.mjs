// input:  Claude stream-json requests and standalone manager prompts
// output: deterministic parent, manager, coder and reviewer turns
// pos:    Fake Claude provider for packed manager-arm tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import fs from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
if (argv[0] !== '--observation') throw new Error('fake manager Claude needs --observation');
const observation = argv[1];
const backendArgs = argv.slice(2);
if (backendArgs.includes('--version')) {
  process.stdout.write('2.1.220 (Claude Code)\n');
  process.exit(0);
}

function option(name) {
  const index = backendArgs.indexOf(name);
  return index < 0 ? '' : backendArgs[index + 1] ?? '';
}

function role() {
  const prompt = option('--system-prompt');
  if (prompt.includes('task-tree manager')) return 'manager';
  if (prompt.includes('read-only implementation auditor')) return 'reviewer';
  if (prompt.includes('code implementer')) return 'coder';
  return 'parent';
}

function nextManagerReply(message) {
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

function replyFor(message) {
  const selected = role();
  if (selected === 'manager') return nextManagerReply(message);
  if (selected === 'reviewer') return 'verified. [IMPL-APPROVED]';
  if (selected === 'coder') return 'implemented public leaf';
  return message.includes('manager_parent_question') ? 'trial parent answer' : 'direct parent ready';
}

function emit(request, text) {
  process.stdout.write(`${JSON.stringify({ type: 'assistant', message: {
    id: 'manager-fake-message', role: 'assistant', model: 'fake-manager-claude',
    content: [{ type: 'text', text }], usage: {
      input_tokens: 3, output_tokens: 2,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    },
  } })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    session_id: request.session_id, result: text, total_cost_usd: 0, num_turns: 1,
    usage: { input_tokens: 3, output_tokens: 2,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  })}\n`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.once('line', line => {
  const request = JSON.parse(line);
  const body = request.message;
  const message = typeof body === 'string' ? body
    : typeof body?.content === 'string' ? body.content
      : Array.isArray(body?.content) ? body.content.map(item => item.text ?? '').join('')
        : String(request.prompt ?? '');
  const selected = role();
  const records = fs.existsSync(observation)
    ? JSON.parse(fs.readFileSync(observation, 'utf8')) : [];
  records.push({ role: selected, cwd: process.cwd(), args: backendArgs });
  fs.writeFileSync(observation, JSON.stringify(records));
  emit(request, replyFor(String(message)));
  lines.close();
});
