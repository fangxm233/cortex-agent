// input:  PI rpc stdin commands and an --observation path
// output: one answered turn on stdout plus the env/argv it was actually given
// pos:    PI-shaped backend stand-in for full runOneShotAgent trials
// >>> If I am updated, update my header and folder CORTEX.md <<<

// The pinned trial environment carries no test variables into the child, so the observation path
// arrives as the two leading argv members the launcher prepends; everything after them is what the
// adapter really passed. Only the model is faked: the framing, the command set and the event shapes
// are PI's own rpc protocol as `pi/event-parser.ts` reads it.

import fs from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
if (argv[0] !== '--observation') throw new Error('pi-rpc-cli: --observation must lead argv');
fs.writeFileSync(argv[1], JSON.stringify({
  env: process.env,
  argv: argv.slice(2),
  pid: process.pid,
  ppid: process.ppid,
  cwd: process.cwd(),
}));

function say(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on('line', (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }
  if (command.type === 'get_state') {
    say({
      type: 'response',
      id: command.id,
      command: 'get_state',
      success: true,
      data: { sessionId: 'pi-trial-session' },
    });
    return;
  }
  if (command.type === 'get_session_stats') {
    say({
      type: 'response',
      id: command.id,
      command: 'get_session_stats',
      success: true,
      data: { contextUsage: { contextWindow: 200000, tokens: 1024, percent: 0.5 } },
    });
    return;
  }
  if (command.type === 'prompt') {
    say({
      type: 'message_update',
      message: { id: 'msg-1' },
      assistantMessageEvent: { type: 'text_delta', delta: 'trial reply' },
    });
    say({
      type: 'agent_end',
      messages: [{
        role: 'assistant',
        provider: 'anthropic',
        model: 'pi-reported-trial',
        usage: { input: 1200, output: 42, cost: { total: 0.0031 } },
      }],
    });
    // Not an exit point: the adapter writes its terminal context-usage probe at this instant, so a
    // child that left here would race that write onto a closed pipe.
    say({ type: 'agent_settled' });
  }
});

// The adapter ends stdin to close the session; that EOF is the only shutdown signal PI's rpc mode
// has, and a child still alive 5 s later is killed instead of exiting cleanly.
lines.on('close', () => process.exit(0));
