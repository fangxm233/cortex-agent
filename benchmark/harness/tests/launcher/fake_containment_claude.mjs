// input:  run config, sealed environment, distinct probe endpoints
// output: deterministic Claude reply and containment probe evidence
// pos:    Container-side fixture for the exact Harbor boundary trial
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { createInterface } from 'node:readline';

const ARTIFACT_ROOT = '/logs/artifacts';
const EVIDENCE_PATH = `${ARTIFACT_ROOT}/containment-probes.json`;
const MARKER_PATH = `${ARTIFACT_ROOT}/host-inspection-complete`;
const RUN_CONFIG_PATH = '/logs/agent/arm-resolution.json';
const INSTRUCTION_PATH = '/logs/agent/instruction.md';
const DECLARED_MOUNTS = ['/logs/agent', '/logs/artifacts', '/logs/verifier'];
const FORBIDDEN_MOUNTS = ['/opt/node', '/var/run/docker.sock', '/workspace/Cortex'];
const FORBIDDEN_KEYS = /^(AWS_|AZURE_|GOOGLE_|KUBECONFIG$|SLACK_|FEISHU_|SSH_|GPG_|DOCKER_|CONTAINER_|NODE_OPTIONS$|NODE_PATH$|NPM_TOKEN$)/;
const PROVIDER_SECRET_KEYS = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
const NETWORK_DENIAL_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT',
]);
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

function postJson(url, token, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request(`${url}/v1/messages?beta=true`, {
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
  let localWrite = false;
  try {
    fs.writeFileSync(path, 'container-local-write');
    localWrite = true;
  } catch {}
  return { visible_before: visibleBefore, local_overlay_write: localWrite };
}

function outcome(name, passed, boundary, observation) {
  return {
    name, status: passed ? 'passed' : 'failed', boundary, observation,
  };
}

async function siblingProxyOutcome(url, token, body) {
  try {
    const response = await postJson(url, token, body);
    return outcome(
      'sibling-proxy-route', response.status === 403,
      'proxy-source', { status: response.status },
    );
  } catch (error) {
    const reason = error?.code ?? 'unknown';
    return outcome(
      'sibling-proxy-route', NETWORK_DENIAL_CODES.has(reason),
      'network', { reason, target_sha256: sha256(url) },
    );
  }
}

async function networkOutcomes(input, credential) {
  const body = { model: input.model, prompt: 'synthetic containment request' };
  const proxyUrl = process.env.ANTHROPIC_BASE_URL;
  const proxyToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const proxy = await postJson(proxyUrl, proxyToken, body);
  const sibling = await siblingProxyOutcome(input.sibling_proxy_url, proxyToken, body);
  const blocked = await Promise.all(Object.entries(input.denied_tcp)
    .map(async ([name, target]) => [name, {
      ...await connectProbe(target), target_sha256: sha256(JSON.stringify(target)),
    }]));
  return [
    outcome('trial-fake-proxy', proxy.status === 200
      && proxyUrl === credential.proxy_base_url
      && proxyToken === credential.dummy_token_ref,
    'scoped-proxy', { status: proxy.status, production_environment: true }),
    sibling,
    ...blocked.map(([name, result]) => outcome(name, result.blocked, 'network', result)),
  ];
}

function readProbeInput() {
  const instruction = fs.readFileSync(INSTRUCTION_PATH, 'utf8');
  const marker = instruction.split('\n').find(line => line.startsWith('PROBE_INPUT_B64='));
  if (!marker) throw new Error('canonical instruction omitted probe input');
  return JSON.parse(Buffer.from(marker.slice('PROBE_INPUT_B64='.length), 'base64url'));
}

async function waitForHostInspection() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(MARKER_PATH)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('host inspection marker did not arrive');
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
    total_cost_usd: 0, num_turns: 1,
    usage: { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  })}\n`);
}

async function main() {
  const config = JSON.parse(fs.readFileSync(RUN_CONFIG_PATH, 'utf8'));
  const input = readProbeInput();
  const pidOne = parseEnvironmentFile('/proc/1/environ');
  const ownEnvironment = { ...process.env };
  const canaries = [input.host_canary_path, input.sibling_canary_path]
    .map(path => canaryProbe(path));
  const outcomes = await networkOutcomes(input, config.credential);
  outcomes.push(
    outcome('container-environment', true, 'process', {
      pid_one: environmentSurface(pidOne, config.credential.dummy_token_ref),
      agent: environmentSurface(ownEnvironment, config.credential.dummy_token_ref),
    }),
    outcome('container-mounts', true, 'filesystem', mountSurface()),
    outcome('host-canary-isolation', !canaries[0].visible_before, 'filesystem', canaries[0]),
    outcome('sibling-canary-isolation', !canaries[1].visible_before, 'filesystem', canaries[1]),
    outcome('host-daemon-socket', !fs.existsSync('/var/run/docker.sock'), 'filesystem', { visible: false }),
  );
  writeEvidence({
    schema_version: 'cortex-harbor-containment-probes/1',
    trial_id: config.trial_id, root_run_id: config.root_run_id,
    probe_outcomes: outcomes,
  });
  await waitForHostInspection();
  emitReply(await readRequest());
}

try {
  await main();
} catch (error) {
  console.error(error?.stack ?? String(error));
  process.exit(1);
}
