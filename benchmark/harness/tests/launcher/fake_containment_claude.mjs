// input:  run config, sealed environment, sibling probe canaries
// output: fake Claude reply and concurrent containment evidence
// pos:    Container-side fixture for concurrent Harbor trials
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { createInterface } from 'node:readline';

const COORDINATION_ROOT = '/logs/artifacts';
const EVIDENCE_PATH = '/logs/agent/trial-home/logs/containment-probes.json';
const READY_PATH = `${COORDINATION_ROOT}/containment-ready.json`;
const CROSS_INPUT_PATH = `${COORDINATION_ROOT}/cross-trial-input.json`;
const MARKER_PATH = `${COORDINATION_ROOT}/host-inspection-complete`;
const RUN_CONFIG_PATH = '/logs/agent/arm-resolution.json';
const INSTRUCTION_PATH = '/logs/agent/instruction.md';
const WORKSPACE_CANARY_PATH = '/app/trial-canary';
const DECLARED_MOUNTS = ['/logs/agent', '/logs/artifacts', '/logs/verifier'];
const FORBIDDEN_MOUNTS = ['/opt/node', '/var/run/docker.sock', '/workspace/Cortex'];
const FORBIDDEN_KEYS = /^(AWS_|AZURE_|GOOGLE_|KUBECONFIG$|SLACK_|FEISHU_|SSH_|GPG_|DOCKER_|CONTAINER_|NODE_OPTIONS$|NODE_PATH$|NPM_TOKEN$)/;
const PROVIDER_SECRET_KEYS = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
const NETWORK_DENIAL_REASONS = new Set([
  'closed', 'timeout', 'EACCES', 'ECONNREFUSED', 'ECONNRESET',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPERM', 'ETIMEDOUT',
]);
const FILESYSTEM_DENIAL_REASONS = new Set(['EACCES', 'ENOENT', 'EPERM']);
const PROCESS_DENIAL_REASONS = new Set(['EPERM', 'ESRCH']);
const argv = process.argv.slice(2);

if (argv.includes('--version')) {
  process.stdout.write('2.1.220 (Claude Code)\n');
  process.exit(0);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseEnvironmentFile(path) {
  const entries = fs.readFileSync(path).toString('utf8').split('\0').filter(Boolean);
  return Object.fromEntries(entries.map(entry => entry.split(/=(.*)/s).slice(0, 2)));
}

function environmentSurface(environment, dummyToken) {
  const secretEntries = Object.entries(environment)
    .filter(([key]) => PROVIDER_SECRET_KEYS.has(key));
  const hostRootKeys = Object.entries(environment)
    .filter(([, value]) => /^\/(?:home|root)(?:\/|$)/.test(value) || value.includes('/.cortex'))
    .map(([key]) => key).sort();
  return {
    keys: Object.keys(environment).sort(),
    values_sha256: sha256(JSON.stringify(environment, Object.keys(environment).sort())),
    forbidden_keys: Object.keys(environment).filter(key => FORBIDDEN_KEYS.test(key)).sort(),
    host_root_value_keys: hostRootKeys,
    provider_secret_keys: secretEntries.map(([key]) => key).sort(),
    provider_secrets_are_dummy: secretEntries.length > 0
      && secretEntries.every(([, value]) => value === dummyToken),
  };
}

function mountSurface() {
  const lines = fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n');
  const targets = lines.map(line => line.split(' ')[4].replaceAll('\\040', ' '));
  return {
    declared_targets: targets.filter(target => DECLARED_MOUNTS.includes(target)).sort(),
    forbidden_targets: targets.filter(target => FORBIDDEN_MOUNTS.includes(target)).sort(),
    mountinfo_sha256: sha256(lines.join('\n')),
  };
}

function connectProbe(target) {
  return new Promise(resolve => {
    const socket = net.createConnection(target);
    let settled = false;
    const finish = (blocked, reason) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ blocked, reason });
    };
    socket.setTimeout(1200, () => finish(true, 'timeout'));
    socket.once('connect', () => socket.write('GET / HTTP/1.0\r\n\r\n'));
    socket.once('data', () => finish(false, 'response'));
    socket.once('end', () => finish(true, 'closed'));
    socket.once('error', error => finish(true, error.code ?? 'error'));
  });
}

function postJson(url, token, body, target = '/v1/messages?beta=true') {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request(`${url}${target}`, {
      method: 'POST', headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
      }, timeout: 3000,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, bytes: Buffer.concat(chunks).length }));
    });
    request.once('timeout', () => request.destroy(new Error('request timeout')));
    request.once('error', reject);
    request.end(payload);
  });
}

function canaryProbe(path) {
  const visibleBefore = fs.existsSync(path);
  let readable = false;
  let localWrite = false;
  try { fs.readFileSync(path); readable = true; } catch {}
  try { fs.writeFileSync(path, 'container-local-write'); localWrite = true; } catch {}
  return { visible_before: visibleBefore, readable, local_overlay_write: localWrite };
}

function directoryProbe(path) {
  try {
    return { blocked: false, entries: fs.readdirSync(path).length };
  } catch (error) {
    return { blocked: true, reason: error?.code ?? 'unknown', target_sha256: sha256(path) };
  }
}

function processSignalProbe(pid) {
  try {
    process.kill(pid, 0);
    return { blocked: false, reason: 'signal-addressable' };
  } catch (error) {
    return { blocked: true, reason: error?.code ?? 'unknown', pid_sha256: sha256(String(pid)) };
  }
}

function outcome(name, passed, boundary, observation) {
  return {
    name, status: passed ? 'passed' : 'failed', boundary, observation,
  };
}

async function blockedPostOutcome(name, url, token, body, target) {
  const targetHash = sha256(`${url}${target}`);
  try {
    const response = await postJson(url, token, body, target);
    return outcome(name, false, 'proxy-source', {
      status: response.status, target_sha256: targetHash,
    });
  } catch (error) {
    const reason = error?.code ?? 'unknown';
    return outcome(name, NETWORK_DENIAL_REASONS.has(reason), 'network', {
      reason, target_sha256: targetHash,
    });
  }
}

async function expectedStatusOutcome(name, token, body, expected) {
  const url = process.env.ANTHROPIC_BASE_URL;
  const response = await postJson(url, token, body);
  return outcome(name, response.status === expected, 'proxy-capability', {
    status: response.status, target_sha256: sha256(url),
  });
}

async function networkOutcomes(input, credential) {
  const body = { model: input.model, prompt: 'synthetic containment request' };
  const proxyUrl = process.env.ANTHROPIC_BASE_URL;
  const proxyToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const proxy = await postJson(proxyUrl, proxyToken, body);
  const blocked = await Promise.all(Object.entries(input.denied_tcp)
    .map(async ([name, target]) => [name, {
      ...await connectProbe(target), target_sha256: sha256(JSON.stringify(target)),
    }]));
  return [
    outcome('trial-fake-proxy', proxy.status === 200
      && proxyUrl === credential.proxy_base_url
      && proxyToken === credential.dummy_token_ref,
    'scoped-proxy', { status: proxy.status, production_environment: true }),
    ...blocked.map(([name, result]) => outcome(
      name, result.blocked && NETWORK_DENIAL_REASONS.has(result.reason),
      'network', result,
    )),
  ];
}

async function crossTrialOutcomes(cross, input) {
  const sibling = cross.sibling;
  const ownToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const ownBody = { model: input.model, prompt: 'capability replay' };
  const siblingBody = { model: sibling.model, prompt: 'identifier replay' };
  const routes = [
    await expectedStatusOutcome('sibling-capability-replay', sibling.dummy_token, ownBody, 401),
    await expectedStatusOutcome('sibling-identifier-replay', ownToken, siblingBody, 400),
    await blockedPostOutcome(
      'sibling-proxy-route', sibling.proxy_url, sibling.dummy_token,
      siblingBody, '/v1/messages?beta=true',
    ),
    await blockedPostOutcome(
      'sibling-control-callback', sibling.proxy_url, sibling.dummy_token,
      { trial_id: sibling.trial_id }, '/_cortex/lease-echo',
    ),
  ];
  const state = directoryProbe(sibling.state_directory);
  const signal = processSignalProbe(sibling.process_pid);
  return [
    ...routes,
    outcome('sibling-state-enumeration', state.blocked
      && FILESYSTEM_DENIAL_REASONS.has(state.reason), 'state', state),
    outcome('sibling-process-signal', signal.blocked
      && PROCESS_DENIAL_REASONS.has(signal.reason), 'process', signal),
  ];
}

function readProbeInput() {
  const instruction = fs.readFileSync(INSTRUCTION_PATH, 'utf8');
  const marker = instruction.split('\n').find(line => line.startsWith('PROBE_INPUT_B64='));
  if (!marker) throw new Error('canonical instruction omitted probe input');
  return JSON.parse(Buffer.from(marker.slice('PROBE_INPUT_B64='.length), 'base64url'));
}

function ownStateObservation() {
  const state = `${process.env.CORTEX_HOME}/state`;
  return {
    root_confined: state.startsWith('/logs/agent/trial-home/'),
    files: fs.readdirSync(state).sort(),
  };
}

function ownProcessObservation() {
  try {
    process.kill(process.pid, 0);
    return { addressable: true, pid_sha256: sha256(String(process.pid)) };
  } catch (error) {
    return { addressable: false, reason: error?.code ?? 'unknown' };
  }
}

function writeReady(config) {
  fs.writeFileSync(READY_PATH, JSON.stringify({
    schema_version: 'cortex-containment-ready/1',
    trial_id: config.trial_id, root_run_id: config.root_run_id,
  }));
}

async function waitForCrossInput() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(CROSS_INPUT_PATH)) {
      const document = JSON.parse(fs.readFileSync(CROSS_INPUT_PATH, 'utf8'));
      fs.unlinkSync(CROSS_INPUT_PATH);
      return document;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('cross-trial probe input did not arrive');
}

async function waitForHostInspection() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(MARKER_PATH)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('host inspection marker did not arrive');
}

function cleanupCoordination() {
  for (const path of [READY_PATH, CROSS_INPUT_PATH, MARKER_PATH]) {
    try { fs.unlinkSync(path); } catch {}
  }
}

function writeEvidence(document) {
  const temporary = `${EVIDENCE_PATH}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`);
  fs.renameSync(temporary, EVIDENCE_PATH);
}

async function readRequest() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) return JSON.parse(line);
  throw new Error('Claude fixture received no request');
}

function emitReply(request) {
  process.stdout.write(`${JSON.stringify({
    type: 'assistant', message: {
      id: 'containment-message', role: 'assistant', model: 'containment-fixture',
      content: [{ type: 'text', text: 'synthetic containment complete' }],
      usage: { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    session_id: request.session_id, result: 'synthetic containment complete',
    total_cost_usd: 0.000051, num_turns: 1,
    usage: { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  })}\n`);
}

function canaryIsIsolated(observation) {
  return !observation.visible_before && !observation.readable
    && !observation.local_overlay_write;
}

async function containmentOutcomes(config, input, cross, localNetwork) {
  const hostCanary = canaryProbe(input.host_canary_path);
  const siblingCanary = canaryProbe(cross.sibling.state_file);
  const siblingWorkspace = canaryProbe(cross.sibling.workspace_file);
  const ownState = ownStateObservation();
  const ownProcess = ownProcessObservation();
  const outcomes = [...localNetwork, ...await crossTrialOutcomes(cross, input)];
  outcomes.push(
    outcome('container-environment', true, 'process', {
      pid_one: environmentSurface(
        parseEnvironmentFile('/proc/1/environ'), config.credential.dummy_token_ref,
      ),
      agent: environmentSurface({ ...process.env }, config.credential.dummy_token_ref),
    }),
    outcome('container-mounts', true, 'filesystem', mountSurface()),
    outcome('host-canary-isolation', canaryIsIsolated(hostCanary), 'filesystem', hostCanary),
    outcome('sibling-canary-isolation', canaryIsIsolated(siblingCanary), 'filesystem', siblingCanary),
    outcome('sibling-workspace-isolation', canaryIsIsolated(siblingWorkspace),
      'workspace', siblingWorkspace),
    outcome('host-daemon-socket', !fs.existsSync('/var/run/docker.sock'), 'filesystem', { visible: false }),
    outcome('own-workspace', fs.readFileSync(WORKSPACE_CANARY_PATH, 'utf8') === config.trial_id,
      'workspace', { confined: true }),
    outcome('own-state-root', ownState.root_confined
      && JSON.stringify(ownState.files) === JSON.stringify([
        'executions.json', 'sessions.json', 'tasks.json', 'threads.json',
      ]), 'state', ownState),
    outcome('own-process-tree', ownProcess.addressable, 'process', ownProcess),
  );
  return outcomes;
}

async function main() {
  const config = JSON.parse(fs.readFileSync(RUN_CONFIG_PATH, 'utf8'));
  const input = readProbeInput();
  fs.writeFileSync(WORKSPACE_CANARY_PATH, config.trial_id);
  const localNetwork = await networkOutcomes(input, config.credential);
  writeReady(config);
  const cross = await waitForCrossInput();
  writeEvidence({
    schema_version: 'cortex-harbor-containment-probes/1',
    trial_id: config.trial_id, root_run_id: config.root_run_id,
    probe_outcomes: await containmentOutcomes(config, input, cross, localNetwork),
  });
  await waitForHostInspection();
  cleanupCoordination();
  emitReply(await readRequest());
}

try {
  await main();
} catch (error) {
  console.error(error?.stack ?? String(error));
  process.exit(1);
}
