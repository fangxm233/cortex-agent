// input:  redacted MCP drafts and edited form state
// output: name, payload, secret-patch and dirty-detection regressions
// pos:    Unit tests for the plugin authoring view model
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import type { PluginsMcpRead } from '@cortex-agent/ui-contract';
import {
  draftsFromRead, emptyDraft, isCanonicalName, mcpDraftIssues, replaceDraft, sameMcpDrafts, toInput,
} from './plugin-authoring-vm';

const READ: PluginsMcpRead = {
  pluginId: 'alpha',
  supported: true,
  servers: [
    { name: 'local', type: 'stdio', command: './bin/server', args: ['--verbose'], cwd: '${PLUGIN_ROOT}', envKeys: ['TOKEN'] },
    { name: 'remote', type: 'streamable-http', url: 'https://api.example.com/mcp', headerKeys: ['Authorization'] },
  ],
};

describe('isCanonicalName', () => {
  it('accepts the shape the server accepts and nothing else', () => {
    expect(isCanonicalName('code-review')).toBe(true);
    expect(isCanonicalName('a1')).toBe(true);
    expect(isCanonicalName('Code-Review')).toBe(false);
    expect(isCanonicalName('double--hyphen')).toBe(false);
    expect(isCanonicalName('-leading')).toBe(false);
    expect(isCanonicalName('')).toBe(false);
  });
});

describe('MCP drafts', () => {
  it('loads every stored secret as kept, never as a value', () => {
    const drafts = draftsFromRead(READ);

    expect(drafts[0].secrets).toEqual([{ key: 'TOKEN', value: null }]);
    expect(drafts[1].secrets).toEqual([{ key: 'Authorization', value: null }]);
    expect(JSON.stringify(drafts)).not.toContain('Bearer');
  });

  it('round-trips a stdio server into the write payload', () => {
    expect(toInput(draftsFromRead(READ)[0])).toEqual({
      name: 'local',
      type: 'stdio',
      command: './bin/server',
      args: ['--verbose'],
      cwd: '${PLUGIN_ROOT}',
      env: { TOKEN: null },
    });
  });

  it('drops empty optional fields rather than writing them as blanks', () => {
    const draft = { ...emptyDraft('s0'), name: 'bare', command: 'node' };

    expect(toInput(draft)).toEqual({ name: 'bare', type: 'stdio', command: 'node' });
  });

  it('sends a replaced secret as a string and a kept one as null', () => {
    const drafts = replaceDraft(draftsFromRead(READ), 's0', {
      secrets: [{ key: 'TOKEN', value: 'fresh' }, { key: 'EXTRA', value: '' }],
    });

    expect(toInput(drafts[0]).env).toEqual({ TOKEN: 'fresh', EXTRA: '' });
  });

  it('flags what the server would reject, before the round trip', () => {
    expect(mcpDraftIssues(draftsFromRead(READ))).toEqual([]);
    expect(mcpDraftIssues([emptyDraft('s0')])).toEqual(['name-missing', 'command-missing']);
    expect(mcpDraftIssues([
      { ...emptyDraft('s0'), name: 'dup', command: 'node' },
      { ...emptyDraft('s1'), name: 'dup', command: 'node' },
    ])).toEqual(['name-duplicate']);
    expect(mcpDraftIssues([
      { ...emptyDraft('s0'), name: 'x', type: 'sse' },
    ])).toEqual(['url-missing']);
    expect(mcpDraftIssues([
      { ...emptyDraft('s0'), name: 'x', command: 'node', secrets: [{ key: 'A', value: '1' }, { key: 'A', value: '2' }] },
    ])).toEqual(['secret-key-duplicate']);
  });

  it('treats a re-render of the same values as clean and a real edit as dirty', () => {
    const base = draftsFromRead(READ);

    expect(sameMcpDrafts(base, draftsFromRead(READ))).toBe(true);
    expect(sameMcpDrafts(base, replaceDraft(base, 's0', { command: 'other' }))).toBe(false);
  });
});
