import { describe, expect, it } from 'vitest';
import { en, zh } from '@/i18n/vocab';
import type { ToolCall } from '@/features/session/composer/chat-content';
import { bareToolName, toolCategory, toolRunNow, toolRunParts, toolRunText } from './tool-summary';

const call = (kind: string, input = ''): ToolCall => ({ kind, input });

describe('tool run summary', () => {
  it('recognises tools through server prefixes, remote names and device labels', () => {
    expect(bareToolName('mcp__cortex-core__send_decision')).toBe('send_decision');
    expect(bareToolName('bash:gpu-box')).toBe('bash');
    expect(toolCategory('remote_read')).toBe('read');
    expect(toolCategory('Bash')).toBe('command');
    expect(toolCategory('MultiEdit')).toBe('edit');
    expect(toolCategory('Glob')).toBe('search');
    expect(toolCategory('WebFetch')).toBe('web');
    expect(toolCategory('mcp__cortex-core__plan_enter')).toBe('other');
  });

  it('counts calls by what they did, in first-appearance order, naming a lone file', () => {
    const calls = [
      call('Bash', 'pnpm test'), call('Read', '/repo/a.ts'), call('Bash', 'git diff'),
      call('Edit', '/repo/src/parser.ts'), call('Edit', '/repo/src/parser.ts'), call('Read', '/repo/b.ts'),
      call('mcp__cortex-core__send_decision', '{"title":"x"}'),
    ];
    expect(toolRunParts(calls)).toEqual([
      { category: 'command', count: 2 },
      { category: 'read', count: 2 },
      { category: 'edit', count: 2, name: 'parser.ts' },
      { category: 'other', count: 1, name: 'send_decision' },
    ]);
    expect(toolRunText(calls, en)).toBe('Ran 2 commands · Read 2 files · Edited parser.ts · Called send_decision');
    expect(toolRunText(calls, zh)).toBe('运行了 2 条命令 · 读取 2 个文件 · 编辑 parser.ts · 调用 send_decision');
  });

  it('does not name a file from a cut-off or non-path input', () => {
    expect(toolRunText([call('Read', '/very/long/path/that/was/cut…')], en)).toBe('Read 1 file');
    expect(toolRunText([call('Write', 'a.ts'), call('Write', 'b.ts')], en)).toBe('Edited 2 files');
    expect(toolRunText([call('Read', 'gpu:/tmp/b.jpg')], en)).toBe('Read b.jpg');
  });

  it('counts thoughts interleaved with the calls', () => {
    const calls: ToolCall[] = [call('Grep', 'x'), { kind: 'thinking', input: 'hmm', thinking: true }, call('Grep', 'y')];
    expect(toolRunText(calls, en)).toBe('Searched 2 times · Thought once');
  });
});

describe('toolRunNow', () => {
  it('says what the latest step is doing, naming the command or file', () => {
    expect(toolRunNow({ kind: 'thinking', input: 'hmm', thinking: true }, en)).toBe('Thinking');
    expect(toolRunNow({ kind: 'Bash', input: 'pnpm test\n  --run' }, en)).toBe('Running pnpm test');
    expect(toolRunNow({ kind: 'Read', input: '/home/x/src/parser.ts' }, en)).toBe('Reading parser.ts');
    expect(toolRunNow({ kind: 'remote_read', input: 'gpu:/tmp/log.txt' }, en)).toBe('Reading log.txt');
    expect(toolRunNow({ kind: 'Edit', input: '/a/b.ts' }, en)).toBe('Editing b.ts');
    expect(toolRunNow({ kind: 'Grep', input: 'TODO' }, en)).toBe('Searching TODO');
    expect(toolRunNow({ kind: 'mcp__cortex-core__send_view', input: '{}' }, en)).toBe('Calling send_view');
  });
});
