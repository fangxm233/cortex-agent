// The Claude pool identity is compared against the identity of every live process: any change to
// its encoding — a field renamed, reordered or defaulted differently — makes every pooled session
// look foreign and respawns it. These literals pin the encoding byte for byte. The two config
// identities are content hashes of files written under the test home, so they are interpolated
// from the same writers rather than spelled out.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { claudeSpecIdentity } from '../../src/agent-adapter/claude/adapter.js';
import { writeBrowserMcpConfig } from '../../src/agent-adapter/claude/browser-mcp.js';
import { writeClaudeSupplementalMcpConfig } from '../../src/agent-adapter/claude/mcp-config.js';
import { AGENT_CWD } from '../../src/core/paths.js';
import type { McpServerConfig } from '../../src/agent-adapter/types.js';
import { engineSpecFixture } from '../engine-spec-fixture.js';

const ROUTE_IDENTITY = 'url:https://route.example ANTHROPIC_API_KEY=sha256:2d465bb2 '
  + 'ANTHROPIC_AUTH_TOKEN=deleted CLAUDE_CODE_OAUTH_TOKEN=inherited';
const BARE_ROUTE_IDENTITY = 'inherited ANTHROPIC_API_KEY=inherited ANTHROPIC_AUTH_TOKEN=inherited '
  + 'CLAUDE_CODE_OAUTH_TOKEN=inherited';
const SERVERS: McpServerConfig[] = [
  { name: 'pin-server', type: 'stdio', command: 'node', args: ['pin.mjs'], env: {}, cwd: '/srv/pin' },
];
const CDP = 'http://127.0.0.1:9333';

test('a fully specified direct session keeps its identity encoding', () => {
  const spec = engineSpecFixture({
    sessionId: 'pin-session', sessionKey: 'pin-key', cwd: '/tmp/pin-cwd',
    tools: ['bash', 'read'], pluginDirs: ['/p/one', '/p/two'], pluginCapabilityFingerprint: 'fp-1',
    mcpConfigPaths: ['/m/base.json'], mcpToolAllowlist: ['cortex_ask_user'],
    mcpServers: SERVERS, browserCdpEndpoint: CDP, isUserInitiated: true,
    anthropicBaseUrl: 'https://route.example', env: { ANTHROPIC_API_KEY: 'sk-pin' },
    unsetEnv: ['ANTHROPIC_AUTH_TOKEN'],
  });
  spec.flags.teamLead = true;
  spec.flags.disableSkills = true;
  spec.flags.settingSources = ['project'];
  const supplemental = writeClaudeSupplementalMcpConfig(SERVERS).identity;
  const browser = writeBrowserMcpConfig(CDP).identity;
  assert.equal(claudeSpecIdentity(spec), JSON.stringify([
    ['cwd', '/tmp/pin-cwd'],
    ['routeIdentity', ROUTE_IDENTITY],
    ['composition', 'direct'],
    ['interactionBridge', true],
    ['tools', 'Bash,Read'],
    ['pluginCapabilityFingerprint', 'fp-1'],
    ['supplementalMcpConfigIdentity', supplemental],
    ['browserMcpConfigIdentity', browser],
    ['disableSkills', true],
    ['pluginDirs', ['/p/one', '/p/two']],
    ['mcpConfigPaths', ['/m/base.json']],
    ['mcpToolAllowlist', ['cortex_ask_user']],
    ['settingSources', ['project']],
    ['teamLead', true],
  ]));
});

test('a bare spec keeps its identity encoding, with no teamLead entry', () => {
  const spec = engineSpecFixture({ sessionKey: 'bare' });
  assert.equal(claudeSpecIdentity(spec), JSON.stringify([
    ['cwd', AGENT_CWD],
    ['routeIdentity', BARE_ROUTE_IDENTITY],
    ['composition', 'direct'],
    ['interactionBridge', false],
    ['tools', null],
    ['pluginCapabilityFingerprint', null],
    ['supplementalMcpConfigIdentity', null],
    ['browserMcpConfigIdentity', null],
    ['disableSkills', false],
    ['pluginDirs', []],
    ['mcpConfigPaths', []],
    ['mcpToolAllowlist', null],
    ['settingSources', null],
  ]));
});

test('composition none drops the bridge, the lead tools and the runtime MCP configs', () => {
  const spec = engineSpecFixture({
    sessionKey: 'none', mcpComposition: 'none', isUserInitiated: true,
    mcpServers: SERVERS, browserCdpEndpoint: CDP, mcpToolAllowlist: [],
  });
  spec.flags.teamLead = true;
  assert.equal(claudeSpecIdentity(spec), JSON.stringify([
    ['cwd', AGENT_CWD],
    ['routeIdentity', BARE_ROUTE_IDENTITY],
    ['composition', 'none'],
    ['interactionBridge', false],
    ['tools', null],
    ['pluginCapabilityFingerprint', null],
    ['supplementalMcpConfigIdentity', null],
    ['browserMcpConfigIdentity', null],
    ['disableSkills', false],
    ['pluginDirs', []],
    ['mcpConfigPaths', []],
    ['mcpToolAllowlist', []],
    ['settingSources', null],
  ]));
});
