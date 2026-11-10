import { describe, expect, it } from 'vitest';
import type { ClaudeCodeStatus } from '@cortex-agent/ui-contract';
import { en, zh } from '@/i18n';
import {
  claudeCodeBehind, claudeCodeSummary, compareVersions, noticeButtonState,
} from './claude-code-vm';

const status = (over: Partial<ClaudeCodeStatus>): ClaudeCodeStatus => ({
  installed: '2.1.280', latest: '2.1.322', state: 'idle', checkedAt: '2026-11-10T00:00:00Z', ...over,
});

describe('claude code settings summary', () => {
  it('shows both versions when behind and only the installed one when current', () => {
    expect(claudeCodeSummary(status({}), en)).toBe('Installed 2.1.280 · latest 2.1.322');
    expect(claudeCodeSummary(status({ installed: '2.1.322' }), zh)).toBe('已是最新 · 2.1.322');
    expect(claudeCodeBehind(status({}))).toBe(true);
    expect(compareVersions('2.10.0', '2.9.9')).toBeGreaterThan(0);
  });

  it('reports progress and a missing CLI', () => {
    expect(claudeCodeSummary(undefined, en)).toBe('Checking…');
    expect(claudeCodeSummary(status({ state: 'updating' }), en)).toBe('Updating…');
    expect(claudeCodeSummary(status({ installed: null, state: 'failed', failure: 'not_installed' }), en))
      .toBe('Claude Code was not found on the server.');
  });
});

describe('chat card update button', () => {
  const base = { required: '2.1.290', requested: false, busy: false };

  it('offers the update, then shows progress once pressed', () => {
    expect(noticeButtonState({ ...base, status: undefined }, en)).toEqual({ label: 'Update Claude Code', disabled: false });
    expect(noticeButtonState({ ...base, status: status({}), requested: true, busy: true }, en))
      .toEqual({ label: 'Updating…', disabled: true });
  });

  it('settles as updated once the installed version meets the requirement', () => {
    expect(noticeButtonState({ ...base, status: status({ installed: '2.1.322' }) }, zh))
      .toEqual({ label: '已更新到 2.1.322', disabled: true });
  });

  it('offers a retry with the CLI output after a failed update', () => {
    const failed = status({ state: 'failed', failure: 'update_failed', detail: 'Use brew upgrade' });
    expect(noticeButtonState({ ...base, status: failed, requested: true }, en))
      .toEqual({ label: 'Update failed · retry', disabled: false, title: 'Use brew upgrade' });
  });
});
