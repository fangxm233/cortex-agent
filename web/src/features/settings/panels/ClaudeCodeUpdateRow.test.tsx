import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ClaudeCodeStatus } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';
import { ClaudeCodeUpdateRowView } from './ClaudeCodeUpdateRow';
import type { ClaudeCodeUpdate } from '@/features/claude-code-update/useClaudeCodeUpdate';

function render(status: ClaudeCodeStatus, busy = false) {
  const controller: ClaudeCodeUpdate = { status, busy, check: vi.fn(), update: vi.fn() };
  const renderer = create(<LangProvider><ClaudeCodeUpdateRowView controller={controller} /></LangProvider>);
  return { renderer, controller };
}

describe('ClaudeCodeUpdateRowView', () => {
  it('offers the update only when a newer version is known', () => {
    const behind = render({ installed: '2.1.280', latest: '2.1.322', state: 'idle', checkedAt: 'x' });
    const apply = behind.renderer.root.find((n) => n.type === 'button' && n.props['data-claude-code-apply'] !== undefined);
    act(() => { apply.props.onClick(); });
    expect(behind.controller.update).toHaveBeenCalledTimes(1);

    const current = render({ installed: '2.1.322', latest: '2.1.322', state: 'idle', checkedAt: 'x' });
    expect(current.renderer.root.findAll((n) => n.props['data-claude-code-apply'] !== undefined)).toHaveLength(0);
  });

  it('shows a failed update with the CLI output', () => {
    const { renderer } = render({
      installed: '2.1.280', latest: '2.1.322', state: 'failed', failure: 'update_failed', detail: 'EACCES: permission denied',
    });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('Update did not complete.');
    expect(text).toContain('EACCES: permission denied');
  });
});
