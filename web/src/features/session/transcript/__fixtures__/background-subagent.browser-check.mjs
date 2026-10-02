// Controlled-RPC browser smoke, NOT backend/server-to-UI end-to-end verification.
// Start Vite on 5187 first (see background-subagent.browser.tsx), then:
// node src/features/session/transcript/__fixtures__/background-subagent.browser-check.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:5187/src/features/session/transcript/__fixtures__/background-subagent.html';
const port = Number(process.env.BROWSER_DEBUG_PORT ?? 9238);
const profile = await mkdtemp(join(tmpdir(), 'cortex-subagent-browser-'));
const browser = spawn(process.env.CHROME_BIN ?? 'google-chrome', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'inherit'] });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pending = new Map();
const errors = [];
let socket;
let nextId = 0;

async function connect() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: 'PUT', signal: AbortSignal.timeout(1000) });
      const target = await response.json();
      socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
      socket.addEventListener('message', onMessage);
      return;
    } catch { await delay(100); }
  }
  throw new Error('Chrome CDP did not become ready');
}

function onMessage(event) {
  const data = JSON.parse(event.data);
  if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails);
  if (!data.id) return;
  const request = pending.get(data.id);
  if (!request) return;
  clearTimeout(request.timer);
  pending.delete(data.id);
  if (data.error) request.reject(data.error);
  else request.resolve(data.result);
}

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function wait(expression) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate(expression)) return;
    await delay(50);
  }
  const page = await evaluate('JSON.stringify({url: location.href, text: document.body?.innerText})');
  throw new Error(`Timed out: ${expression}\n${page}\n${JSON.stringify(errors)}`);
}

const api = 'window.backgroundSubagent';
const body = 'document.body.innerText';
const header = 'document.querySelector("button[aria-expanded]")';
const detailData = `${api}.fixture.queryClient.getQueryData(${api}.fixture.trpc.sessions.subagentTranscript.queryKey({sessionId:'background-fixture',subagentId:'agent-call#0'}))`;
const click = (label) => evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(label)}).click()`);

async function openChild() {
  await wait(`${header} !== null`);
  await evaluate(`${header}.click()`);
  await wait(`document.querySelector('[data-tool-calls] button') !== null`);
  await evaluate(`document.querySelector('[data-tool-calls] button').click()`);
  await wait(`${body}.includes('early.ts')`);
}

async function verifyIdleUpdates() {
  await openChild();
  await click('Parent idle');
  await click('Later tool + prose');
  await wait(`${header}.textContent.includes('2 tool calls') && ${body}.includes('Later child prose') && ${body}.includes('late-pattern')`);
  assert.equal(await evaluate(`document.querySelector('[data-testid="parent-running"]').textContent`), 'false');
  await click('Complete child');
  await wait(`${body}.includes('Final child prose.') && !${header}.querySelector('[aria-label="running"]')`);
  await evaluate(`${api}.fixture.messageEvent(${api}.fixture.detail.messages[1])`);
  await delay(100);
  assert.equal(await evaluate(`${header}.textContent.includes('2 tool calls') && !${header}.querySelector('[aria-label="running"]')`), true);
  assert.equal(await evaluate(`${body}.split('Later child prose').length`), 2);
}

async function verifyDebugAndReconnect() {
  await click('DEBUG result');
  await wait(`${detailData}?.messages[0].debug?.toolResult?.content.includes('DEBUG result')`);
  await wait(`[...document.querySelectorAll('button')].some(b => b.textContent === '{ }')`);
  await click('{ }');
  await wait(`${body}.includes('DEBUG result saved after tool completion')`);
  // Close the inspector before continuing with the fixture toolbar.
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await click('Miss events + reconnect');
  await wait(`${header}.textContent.includes('3 tool calls') && ${detailData}?.messages.length === 6`);
  await click('Remount with cache');
  await openChild();
  await wait(`${header}.textContent.includes('3 tool calls') && ${body}.includes('Final child prose.')`);
}

async function verifyFirstFetchRace() {
  await click('Reset fixture');
  await wait(`${api}.fixture.calls.includes('sessions.transcript') && ${header}.textContent.includes('1 tool call')`);
  await click('Hold next detail fetch');
  await evaluate(`${header}.click()`);
  await wait(`${api}.fixture.detailReads() === 1`);
  await click('Later tool + prose');
  await wait(`${body}.includes('Later child prose')`);
  await click('Release old detail response');
  await wait(`${detailData}?.messages.length === 3 && ${body}.includes('Later child prose')`);
  assert.equal(await evaluate(`${api}.fixture.detailReads()`), 2);
  assert.equal(await evaluate(`${body}.split('Later child prose').length`), 2);
}

try {
  await connect();
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1100, height: 850, deviceScaleFactor: 1, mobile: false });
  await wait(`!!${api}`);
  console.log('Checking open idle-parent updates');
  await verifyIdleUpdates();
  console.log('Checking DEBUG inspector and reconnect/remount');
  await verifyDebugAndReconnect();
  console.log('Checking first-fetch race');
  await verifyFirstFetchRace();
  assert.deepEqual(errors, []);
  const screenshot = await call('Page.captureScreenshot', { format: 'png' });
  const screenshotPath = join(profile, 'controlled-rpc.png');
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  console.log(`PASS controlled-RPC browser smoke (not backend E2E). Screenshot: ${screenshotPath}`);
} finally {
  socket?.close();
  browser.kill('SIGTERM');
}
