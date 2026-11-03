import { describe, expect, it } from 'vitest';
import { en, zh } from '@/i18n/vocab';
import type { ToolCall } from '@/features/session/composer/chat-content';
import { bareToolName, runLead, thoughtNow, toolCategory, toolStepText } from './tool-summary';

const call = (kind: string, input = '', description?: string): ToolCall => ({ kind, input, ...(description ? { description } : {}) });
const thought: ToolCall = { kind: 'thinking', input: 'hmm', thinking: true };

describe('tool categories', () => {
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
});

describe('toolStepText', () => {
  it('is the call\'s own description, under way or over', () => {
    const described = call('Bash', 'pnpm test', '  Run the parser tests ');
    expect(toolStepText(described, true, en)).toBe('Run the parser tests');
    expect(toolStepText(described, false, zh)).toBe('Run the parser tests');
    expect(toolStepText(call('Bash', 'pnpm test', '   '), true, en)).toBe('Running pnpm test');
  });

  it('says what a call without a description is doing, naming the command or file', () => {
    expect(toolStepText(thought, true, en)).toBe('Thinking');
    expect(toolStepText(call('Bash', 'pnpm test\n  --run'), true, en)).toBe('Running pnpm test');
    expect(toolStepText(call('Read', '/home/x/src/parser.ts'), true, en)).toBe('Reading parser.ts');
    expect(toolStepText(call('remote_read', 'gpu:/tmp/log.txt'), true, en)).toBe('Reading log.txt');
    expect(toolStepText(call('Edit', '/a/b.ts'), true, en)).toBe('Editing b.ts');
    expect(toolStepText(call('Grep', 'TODO'), true, en)).toBe('Searching TODO');
    expect(toolStepText(call('mcp__cortex-core__send_view', '{}'), true, en)).toBe('Calling send_view');
    expect(toolStepText(call('Skill', 'cortex-coder:develop'), true, en)).toBe('Calling skill cortex-coder:develop');
  });

  it('says what a finished call did', () => {
    expect(toolStepText(call('Bash', 'git diff'), false, en)).toBe('Ran git diff');
    expect(toolStepText(call('Read', 'gpu:/tmp/b.jpg'), false, en)).toBe('Read b.jpg');
    expect(toolStepText(call('Edit', '/repo/src/parser.ts'), false, en)).toBe('Edited parser.ts');
    expect(toolStepText(call('Edit', '/repo/src/parser.ts'), false, zh)).toBe('编辑了 parser.ts');
    expect(toolStepText(call('mcp__cortex-core__send_decision', '{}'), false, en)).toBe('Called send_decision');
  });
});

describe('runLead', () => {
  const run = [call('Grep', 'x'), call('Read', 'a.ts'), thought];

  it('is the latest entry while live, and the latest tool call once over', () => {
    expect(runLead(run, true)).toBe(thought);
    expect(runLead(run, false)).toBe(run[1]);
    expect(runLead([thought], false)).toBe(thought);
    expect(runLead([], false)).toBeUndefined();
  });
});

describe('thoughtNow', () => {
  it('is the thought\'s latest line with words, as plain text', () => {
    expect(thoughtNow('**Plan**\n\n- check `parse()`\n\n')).toBe('check parse()');
    expect(thoughtNow('one\r\ntwo')).toBe('two');
    expect(thoughtNow('  \n ')).toBe('');
  });
});
