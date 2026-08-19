// input:  one preinstalled vendor CLI and loopback-only networking
// output: version, CLI isolation, and one synthetic request proof
// pos:    Offline runtime-image preflight for vendor CLI variants
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VERSIONS = { pi: "0.82.1", "claude-code": "2.1.232", codex: "0.117.0" };
const COMMANDS = { pi: "pi", "claude-code": "claude", codex: "codex" };

function fail(message) {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      "Usage: node vendor-runtime-preflight.js --vendor <pi|claude-code|codex> --cli <path>\n\n" +
      "Options:\n  --vendor  Target vendor runtime\n  --cli     Absolute target CLI path\n\n" +
      "Examples:\n  node vendor-runtime-preflight.js --vendor pi --cli /usr/local/bin/pi\n",
    );
    process.exit(0);
  }
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!["--vendor", "--cli"].includes(name) || argv[index + 1] === undefined) {
      fail(`invalid arguments; valid flags: --vendor, --cli, --help`);
    }
    result[name.slice(2)] = argv[index + 1];
  }
  if (!VERSIONS[result.vendor] || !result.cli) {
    fail("--vendor and --cli are required; valid vendors: pi, claude-code, codex");
  }
  return result;
}

function resolveCommand(command) {
  try {
    return execFileSync("/bin/sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function assertCliIsolation(vendor, cli) {
  const target = COMMANDS[vendor];
  if (resolveCommand(target) !== cli) {
    fail(`target CLI ${target} does not resolve to ${cli}`);
  }
  const unexpected = Object.values(COMMANDS).filter(
    (command) => command !== target && resolveCommand(command),
  );
  if (unexpected.length) fail(`non-target vendor CLIs are present: ${unexpected.join(", ")}`);
}

function assertVersion(vendor, cli) {
  const result = spawnSync(cli, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) fail(`${vendor} version command failed: ${result.stderr}`);
  const observed = result.stdout.trim();
  const expected = vendor === "claude-code"
    ? `${VERSIONS[vendor]} (Claude Code)`
    : vendor === "codex" ? `codex-cli ${VERSIONS[vendor]}` : VERSIONS[vendor];
  if (observed !== expected) fail(`${vendor} version mismatch: expected ${expected}, got ${observed}`);
  return observed;
}

function sse(lines) {
  return Buffer.from(`${lines.map((line) => `data: ${JSON.stringify(line)}\n\n`).join("")}data: [DONE]\n\n`);
}

function piResponse() {
  return sse([
    { id: "chatcmpl-preflight", object: "chat.completion.chunk", created: 0, model: "synthetic",
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "chatcmpl-preflight", object: "chat.completion.chunk", created: 0, model: "synthetic",
      choices: [{ index: 0, delta: { content: "PREFLIGHT_OK" }, finish_reason: null }] },
    { id: "chatcmpl-preflight", object: "chat.completion.chunk", created: 0, model: "synthetic",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ]);
}

function claudeResponse() {
  const message = { id: "msg_preflight", type: "message", role: "assistant", content: [],
    model: "synthetic", stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      output_tokens: 1 } };
  const events = [
    { type: "message_start", message },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0,
      delta: { type: "text_delta", text: "PREFLIGHT_OK" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return Buffer.from(events.map(
    (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  ).join(""));
}

function codexResponse() {
  const message = { id: "msg_preflight", type: "message", status: "completed", role: "assistant",
    content: [{ type: "output_text", text: "PREFLIGHT_OK", annotations: [], logprobs: [] }] };
  const base = { id: "resp_preflight", object: "response", status: "in_progress",
    model: "gpt-5.3-codex", output: [], usage: null };
  const completed = { ...base, status: "completed", created_at: 0, error: null,
    incomplete_details: null, instructions: null, max_output_tokens: null, output: [message],
    parallel_tool_calls: true, previous_response_id: null,
    reasoning: { effort: "high", summary: null }, store: false, temperature: null,
    text: { format: { type: "text" }, verbosity: "medium" }, tool_choice: "auto", tools: [],
    top_p: null, truncation: "disabled", usage: { input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 }, output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 }, user: null, metadata: {} };
  return sse([
    { type: "response.created", response: base },
    { type: "response.in_progress", response: base },
    { type: "response.output_item.added", output_index: 0,
      item: { ...message, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: "msg_preflight", output_index: 0,
      content_index: 0, delta: "PREFLIGHT_OK", logprobs: [] },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response: completed },
  ]);
}

function response(vendor) {
  if (vendor === "pi") return piResponse();
  if (vendor === "claude-code") return claudeResponse();
  return codexResponse();
}

function cleanEnvironment(root, extra) {
  return { HOME: root, PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8",
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", ...extra };
}

function runProcess(cli, argv, options) {
  return new Promise((resolve) => {
    const child = spawn(cli, argv, options);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeout);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function runPi(cli, root, port) {
  const agent = join(root, "pi-agent");
  mkdirSync(agent);
  writeFileSync(join(agent, "auth.json"), JSON.stringify({ deepseek: { type: "api_key", key: "dummy" } }));
  const models = { providers: { deepseek: { baseUrl: `http://127.0.0.1:${port}/v1`,
    api: "openai-completions", models: [{ id: "deepseek-chat", name: "Synthetic",
      reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } };
  writeFileSync(join(agent, "models.json"), JSON.stringify(models));
  const env = cleanEnvironment(root, { PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" });
  const argv = ["--print", "--mode", "json", "--no-session", "--no-tools", "--no-extensions",
    "--no-skills", "--no-context-files", "--provider", "deepseek", "--model", "deepseek-chat",
    "Reply PREFLIGHT_OK"];
  return runProcess(cli, argv, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
}

function runClaude(cli, root, port) {
  const base = `http://127.0.0.1:${port}`;
  const env = cleanEnvironment(root, { CLAUDE_CONFIG_DIR: join(root, ".claude"),
    ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: "dummy",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
  const argv = ["--bare", "--print", "--output-format", "json", "--no-session-persistence",
    "--tools", "", "--model", "sonnet", "Reply PREFLIGHT_OK"];
  return runProcess(cli, argv, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
}

function token() {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const claim = { "https://api.openai.com/auth": { chatgpt_account_id: "dummy-preflight" } };
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(claim)}.${encode({ dummy: true })}`;
}

function runCodex(cli, root, port) {
  const home = join(root, ".codex");
  mkdirSync(home);
  const value = token();
  const auth = { tokens: { id_token: value, access_token: value,
    refresh_token: "dummy-refresh-never-forward" }, last_refresh: new Date().toISOString() };
  writeFileSync(join(home, "auth.json"), JSON.stringify(auth));
  const config = `model = "gpt-5.3-codex"\nmodel_provider = "synthetic"\nweb_search = "disabled"\n` +
    `[model_providers.synthetic]\nname = "synthetic"\nbase_url = "http://127.0.0.1:${port}/codex"\n` +
    `wire_api = "responses"\nrequires_openai_auth = true\n`;
  writeFileSync(join(home, "config.toml"), config);
  const argv = ["exec", "--skip-git-repo-check", "--ephemeral", "--json", "Reply PREFLIGHT_OK"];
  return runProcess(cli, argv, { cwd: root, env: cleanEnvironment(root, { CODEX_HOME: home }),
    stdio: ["ignore", "pipe", "pipe"], timeout: 45_000 });
}

function runVendor(vendor, cli, root, port) {
  if (vendor === "pi") return runPi(cli, root, port);
  if (vendor === "claude-code") return runClaude(cli, root, port);
  return runCodex(cli, root, port);
}

async function main() {
  const { vendor, cli } = parseArgs(process.argv.slice(2));
  assertCliIsolation(vendor, cli);
  const version = assertVersion(vendor, cli);
  const requests = [];
  const server = createServer((request, reply) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      if (!body) {
        reply.writeHead(404, { "content-length": "0" });
        reply.end();
        return;
      }
      requests.push({ path: request.url, body: JSON.parse(body) });
      const payload = response(vendor);
      reply.writeHead(200, { "content-type": "text/event-stream", "content-length": payload.length });
      reply.end(payload);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const root = mkdtempSync(join(tmpdir(), "vendor-preflight-"));
  const result = await runVendor(vendor, cli, root, server.address().port);
  await new Promise((resolve) => server.close(resolve));
  if (result.status !== 0) fail(`${vendor} synthetic request failed: ${result.stderr}`);
  if (requests.length !== 1) fail(`${vendor} emitted ${requests.length} requests; expected exactly one`);
  process.stdout.write(`${JSON.stringify({ ok: true, vendor, version, requests: 1 })}\n`);
}

await main();
