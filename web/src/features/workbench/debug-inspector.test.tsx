// input:  DEBUG detail presentational components and transcript rows
// output: regression coverage for hover-only controls and unabridged modal content
// pos:    Desktop-only DEBUG transcript inspector specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LangProvider } from '@/i18n';
import { MessageStream } from './MessageStream';
import { ToolCallsRow } from './ToolCallsRow';
import { DebugDetailsContent, DebugInspectButton, formatDebugValue } from './DebugDetailsModal';
import type { ChatRow } from './transcript-vm';

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<LangProvider>{node}</LangProvider>);
}

describe('desktop DEBUG inspector controls', () => {
  it('renders a hover/focus-only button for a user row with an exact agent message', () => {
    const rows: ChatRow[] = [{ kind: 'user', text: 'visible', debug: { agentMessage: 'context\nvisible' } }];
    const html = render(<MessageStream rows={rows} loading={false} />);
    expect(html).toContain('aria-label="Inspect DEBUG data"');
    expect(html).toContain('opacity-0');
    expect(html).toContain('group-hover:opacity-100');
  });

  it('still renders the inspector for an attachment-only user message', () => {
    const rows: ChatRow[] = [{
      kind: 'user',
      text: '',
      attachments: [{ name: 'shot.png', path: 'workspace/shot.png', size: 12, mimeType: 'image/png', type: 'image' }],
      debug: { agentMessage: 'context for attachment-only message' },
    }];
    expect(render(<MessageStream rows={rows} loading={false} />)).toContain('aria-label="Inspect DEBUG data"');
  });

  it('renders no inspector button when the transcript DTO carries no DEBUG metadata', () => {
    const html = render(<MessageStream rows={[{ kind: 'user', text: 'ordinary' }]} loading={false} />);
    expect(html).not.toContain('Inspect DEBUG data');
  });

  it('preserves the original collapsed chip chrome when DEBUG metadata is absent', () => {
    const html = render(<ToolCallsRow calls={[{ label: 'Read', kind: 'Read', input: 'a.ts' }]} />);
    expect(html).toContain('padding:1px 6px');
    expect(html).not.toContain('display:inline-flex');
  });

  it('renders one hover-only inspector button for each tool call carrying DEBUG data', () => {
    const html = render(<ToolCallsRow calls={[
      { label: 'Read', kind: 'Read', input: 'a.ts', debug: { toolInput: { file_path: '/full/a.ts' } } },
      { label: 'Bash', kind: 'Bash', input: 'echo …', debug: { toolInput: { command: 'echo full' }, toolResult: { content: 'all output', isError: false } } },
    ]} />);
    expect((html.match(/aria-label="Inspect DEBUG data"/g) ?? []).length).toBe(2);
    expect(html).toContain('group-hover:opacity-100');
  });

  it('button is a real keyboard-focusable control rather than a decorative icon', () => {
    const html = render(<DebugInspectButton onClick={() => {}} />);
    expect(html).toContain('<button');
    expect(html).toContain('type="button"');
    expect(html).toContain('focus-visible:opacity-100');
  });
});

describe('DEBUG detail content', () => {
  it('renders the complete multiline agent message without truncation', () => {
    const full = 'system context\nline two\nline three';
    const html = render(<DebugDetailsContent detail={{ kind: 'user', agentMessage: full }} />);
    expect(html).toContain('system context');
    expect(html).toContain('line two');
    expect(html).toContain('line three');
    expect(html).not.toContain('…');
  });

  it('renders complete structured parameters and full successful result', () => {
    const html = render(<DebugDetailsContent detail={{
      kind: 'tool',
      toolName: 'Bash',
      toolInput: { command: 'printf "secret\\n"', timeout: 120000, nested: { keep: true } },
      toolResult: { content: 'first line\nsecond line', isError: false },
    }} />);
    expect(html).toContain('&quot;timeout&quot;: 120000');
    expect(html).toContain('&quot;keep&quot;: true');
    expect(html).toContain('first line');
    expect(html).toContain('second line');
    expect(html).toContain('SUCCESS');
  });

  it('distinguishes error and pending tool results', () => {
    const failed = render(<DebugDetailsContent detail={{ kind: 'tool', toolName: 'Read', toolInput: {}, toolResult: { content: 'permission denied', isError: true } }} />);
    const pending = render(<DebugDetailsContent detail={{ kind: 'tool', toolName: 'Read', toolInput: {} }} />);
    expect(failed).toContain('ERROR');
    expect(failed).toContain('permission denied');
    expect(pending).toContain('PENDING');
  });

  it('formats strings verbatim and objects as readable JSON', () => {
    expect(formatDebugValue('a\nb')).toBe('a\nb');
    expect(formatDebugValue({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});
