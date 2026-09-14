// input:  resolved engine specs and temporary plugin trees
// output: prompt, plugin, skill, MCP, and hook identity proofs
// pos:    Regression tests for exact spawn role identity
// >>> If I am updated, update my header and folder CORTEX.md <<<

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, it } from 'vitest';
import { DEFAULT_TOOLS } from '../../../src/agent-adapter/claude/defaults.js';
import { buildSpawnArgs } from '../../../src/agent-adapter/claude/spawn-args.js';
import type { EngineSpec } from '../../../src/agent-adapter/types.js';
import {
  directoryContentSha256, roleSurfaceFromSpec,
} from '../../../src/domain/benchmark/role-surface.js';
import { engineSpecFixture } from '../../engine-spec-fixture.js';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'role-surface-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function specFixture(pluginDirs: string[] = []): EngineSpec {
  return engineSpecFixture({
    sessionId: null,
    sessionKey: 'fixture',
    resume: false,
    systemPrompt: 'system fixture',
    rawTools: 'Bash,Read,Write',
    pluginDirs,
    mcpComposition: 'none',
    mcpConfigPaths: [path.join(root, 'empty-mcp.json')],
    disableHooks: true,
  });
}

it('content-addresses plugin files and discovers skill directories', () => {
  const plugin = path.join(root, 'plugin-a');
  const skill = path.join(plugin, 'skills', 'inspect');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(plugin, 'plugin.json'), '{"name":"fixture"}\n');
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '# Inspect\n');
  const before = directoryContentSha256(plugin);
  const surface = roleSurfaceFromSpec(specFixture([plugin]));
  assert.equal(surface.pluginDirs[0].content_sha256, before);
  assert.deepEqual(surface.skills.map(value => value.name), ['inspect']);
  assert.equal(
    surface.directiveSha256,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  fs.appendFileSync(path.join(skill, 'SKILL.md'), 'changed\n');
  assert.notEqual(directoryContentSha256(plugin), before);
});

it('includes appended Cortex rules in the resolved system-prompt identity', () => {
  const spec = specFixture();
  const base = roleSurfaceFromSpec(spec);
  spec.prompt.append = 'resolved global rule';
  assert.notEqual(roleSurfaceFromSpec(spec).systemPromptSha256, base.systemPromptSha256);
});

it('captures PI-projected skill directories and portable MCP capability fingerprints', () => {
  const skill = path.join(root, 'projected-skills', 'inspect');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '# Inspect\n');
  const spec = specFixture();
  spec.plugins.skillDirs = [skill];
  spec.plugins.fingerprint = 'b'.repeat(64);
  const surface = roleSurfaceFromSpec(spec);
  assert.deepEqual(surface.skills, [{
    name: 'inspect', content_sha256: directoryContentSha256(skill),
  }]);
  assert.ok(surface.pluginDirs.some(value => (
    value.path === '@plugin-capability' && value.content_sha256 === 'b'.repeat(64)
  )));
});

it('hashes a caller-supplied thread directive instead of the one-shot empty directive', () => {
  const empty = roleSurfaceFromSpec(specFixture());
  const directed = roleSurfaceFromSpec(specFixture(), 'benchmark directive');
  assert.notEqual(directed.directiveSha256, empty.directiveSha256);
  assert.equal(
    directed.directiveSha256,
    '66ef966ddb7cadb3286bb29d17558fff3e1028b6a47659e57247d3464ba0e357',
  );
});

it('hashes Claude default tools when the spawn omits or blanks raw tools', () => {
  const expected = DEFAULT_TOOLS.split(',');
  for (const rawTools of [undefined, '']) {
    const spec = specFixture();
    spec.tools.rawClaude = rawTools;
    assert.deepEqual(roleSurfaceFromSpec(spec).tools, expected);
  }
});

it('hashes the exact tools, MCP composition, and hook policy used by Claude argv', () => {
  const spec = specFixture();
  fs.writeFileSync(spec.mcp.configPaths![0], '{"mcpServers":{}}\n');
  const surface = roleSurfaceFromSpec(spec);
  const args = buildSpawnArgs({
    tools: spec.tools.rawClaude!,
    systemPrompt: spec.prompt.system,
    pluginDirs: spec.plugins.dirs,
    needsResume: false,
    sessionId: '00000000-0000-4000-8000-000000000001',
    mcpComposition: spec.mcp.composition,
    mcpConfigPaths: spec.mcp.configPaths,
    disableHooks: spec.flags.disableHooks,
    streamDeltas: false,
  });
  const toolsIndex = args.indexOf('--tools');
  assert.deepEqual(args[toolsIndex + 1].split(','), surface.tools);
  assert.equal(surface.mcpComposition, 'none');
  assert.deepEqual(args.slice(args.indexOf('--mcp-config'), args.indexOf('--strict-mcp-config')), [
    '--mcp-config', spec.mcp.configPaths![0],
  ]);
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
  assert.deepEqual(settings.hooks, {});
  assert.deepEqual(surface.hookPolicy, settings.hooks);
});

it('orders plugin and skill identities independently of config order', () => {
  const first = path.join(root, 'z-plugin');
  const second = path.join(root, 'a-plugin');
  fs.mkdirSync(path.join(first, 'skills', 'z-skill'), { recursive: true });
  fs.mkdirSync(path.join(second, 'skills', 'a-skill'), { recursive: true });
  fs.writeFileSync(path.join(first, 'skills', 'z-skill', 'SKILL.md'), 'z\n');
  fs.writeFileSync(path.join(second, 'skills', 'a-skill', 'SKILL.md'), 'a\n');
  const forward = roleSurfaceFromSpec(specFixture([first, second]));
  const reverse = roleSurfaceFromSpec(specFixture([second, first]));
  assert.deepEqual(forward.pluginDirs, reverse.pluginDirs);
  assert.deepEqual(forward.skills, reverse.skills);
  assert.deepEqual(forward.pluginDirs.map(value => value.path), [second, first]);
  assert.deepEqual(forward.skills.map(value => value.name), ['a-skill', 'z-skill']);
});
