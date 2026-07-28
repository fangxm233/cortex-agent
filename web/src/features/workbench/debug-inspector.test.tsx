// input:  DEBUG rows, message actions, server warnings, details
// output: embedded inspector, warning, and full-detail regressions
// pos:    Desktop DEBUG transcript inspector specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LangProvider } from '@/i18n';
import { MessageStream } from './MessageStream';
import { HoverActionPill, M_EDIT_COPY } from './MessageEdit';
import { ToolCallsRow, toolWarningStyle } from './ToolCallsRow';
import { modalContentClass } from '@/design/Modal';
import {
  DEBUG_MODAL_SIZE,
  DebugDetailsContent,
  DebugInspectButton,
  characterCount,
  formatDebugValue,
} from './DebugDetailsModal';
import type { ChatRow } from './transcript-vm';

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<LangProvider>{node}</LangProvider>);
}

describe('desktop DEBUG inspector controls', () => {
  it('renders a hover/focus-only button for a user row without placing it beyond the right edge', () => {
    const rows: ChatRow[] = [{ kind: 'user', text: 'visible', debug: { agentMessage: 'context\nvisible' } }];
    const html = render(<MessageStream rows={rows} loading={false} />);
    expect(html).toContain('aria-label="Inspect DEBUG data"');
    expect(html).toContain('opacity-0');
    expect(html).toContain('group-hover:opacity-100');
    expect(html).not.toContain('left:100%');
  });

  it('embeds the inspector in the same action pill as copy and edit', () => {
    const html = render(
      <HoverActionPill
        text="visible"
        copy={M_EDIT_COPY.en}
        onEdit={() => {}}
        extraAction={<DebugInspectButton onClick={() => {}} />}
      />,
    );
    expect(html).toContain('title="Copy"');
    expect(html).toContain('title="Edit message"');
    expect(html).toContain('aria-label="Inspect DEBUG data"');
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

  it('keeps collapsed tool calls on one clipped line', () => {
    const html = render(<ToolCallsRow calls={[
      { label: 'Read', kind: 'Read', input: 'a.ts' },
      { label: 'Bash', kind: 'Bash', input: 'echo test' },
    ]} />);
    expect(html).toContain('flex-wrap:nowrap');
    expect(html).toContain('white-space:nowrap');
    expect(html).toContain('overflow:hidden');
    expect(html).not.toContain('flex-wrap:wrap');
  });

  it('keeps DEBUG controls hidden when collapsed and marks oversized tool badges amber', () => {
    const html = render(<ToolCallsRow calls={[
      { label: 'Read', kind: 'Read', input: 'a.ts', debug: { toolInput: { file_path: '/full/a.ts' } } },
      { label: 'Bash', kind: 'Bash', input: 'echo …', debug: { toolInput: { command: 'echo full' }, toolResult: { content: 'all output', isError: false }, overCharacterThreshold: true } },
    ]} />);
    expect(html).not.toContain('aria-label="Inspect DEBUG data"');
    expect(html).toContain('padding:1px 6px');
    expect(html).not.toContain('display:inline-flex');
    expect(html).toContain('background:var(--proto-amber-bg)');
    expect(html).toContain('border:1px solid var(--proto-amber-border)');
    expect(html).toContain('color:var(--proto-amber-fg)');
  });

  it('shares one amber palette between collapsed and expanded tool badges', () => {
    expect(toolWarningStyle(true)).toEqual({
      background: 'var(--proto-amber-bg)',
      border: '1px solid var(--proto-amber-border)',
      color: 'var(--proto-amber-fg)',
    });
    expect(toolWarningStyle(false)).toEqual({});
  });

  it('button is a real keyboard-focusable control rather than a decorative icon', () => {
    const html = render(<DebugInspectButton onClick={() => {}} />);
    expect(html).toContain('<button');
    expect(html).toContain('type="button"');
    expect(html).toContain('focus-visible:opacity-100');
  });

  it('offers a compact button that does not set expanded tool-row height', () => {
    const html = render(<DebugInspectButton compact onClick={() => {}} />);
    expect(html).toContain('h-[18px]');
    expect(html).toContain('min-w-[22px]');
    expect(html).not.toContain('h-[24px]');
  });
});

describe('DEBUG detail content', () => {
  it('renders the complete multiline agent message with its character count', () => {
    const full = 'system context\nline two\nline 😀';
    const html = render(<DebugDetailsContent detail={{ kind: 'user', agentMessage: full }} />);
    expect(html).toContain('system context');
    expect(html).toContain('line two');
    expect(html).toContain('line 😀');
    expect(html).toContain(`${characterCount(full)} CHARACTERS`);
    expect(html).not.toContain('…');
  });

  it('renders complete structured parameters and result with separate character counts', () => {
    const toolInput = { command: 'printf "secret\\n"', timeout: 120000, nested: { keep: true } };
    const result = 'first line\nsecond line';
    const html = render(<DebugDetailsContent detail={{
      kind: 'tool',
      toolName: 'Bash',
      toolInput,
      toolResult: { content: result, isError: false },
    }} />);
    expect(html).toContain('&quot;timeout&quot;: 120000');
    expect(html).toContain('&quot;keep&quot;: true');
    expect(html).toContain('first line');
    expect(html).toContain('second line');
    expect(html).toContain(`${characterCount(formatDebugValue(toolInput))} CHARACTERS`);
    expect(html).toContain(`${characterCount(result)} CHARACTERS`);
    expect(html).toContain('SUCCESS');
  });

  it('distinguishes error and pending tool results without counting pending UI copy', () => {
    const failed = render(<DebugDetailsContent detail={{ kind: 'tool', toolName: 'Read', toolInput: {}, toolResult: { content: 'permission denied', isError: true } }} />);
    const pending = render(<DebugDetailsContent detail={{ kind: 'tool', toolName: 'Read', toolInput: {} }} />);
    expect(failed).toContain('ERROR');
    expect(failed).toContain('permission denied');
    expect((failed.match(/CHARACTERS/g) ?? []).length).toBe(2);
    expect(pending).toContain('PENDING');
    expect((pending.match(/CHARACTERS/g) ?? []).length).toBe(1);
  });

  it('counts Unicode code points rather than UTF-16 code units', () => {
    expect(characterCount('A😀中')).toBe(3);
  });

  it('formats strings verbatim and objects as readable JSON', () => {
    expect(formatDebugValue('a\nb')).toBe('a\nb');
    expect(formatDebugValue({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it('uses the wide modal size without changing the default modal width', () => {
    expect(modalContentClass(DEBUG_MODAL_SIZE)).toContain('max-w-3xl');
    expect(modalContentClass(DEBUG_MODAL_SIZE)).not.toContain('max-w-lg');
    expect(modalContentClass()).toContain('max-w-lg');
  });
});
