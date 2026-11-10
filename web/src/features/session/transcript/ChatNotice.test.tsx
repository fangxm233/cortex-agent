import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import { ChatNotice } from './ChatNotice';

const openLogin = vi.hoisted(() => vi.fn());
vi.mock('@/features/auth/LoginFlowProvider', () => ({
  useOptionalLoginFlow: () => ({ openLogin }),
}));

describe('ChatNotice', () => {

  it('invokes the one-click auth action without rendering its metadata', () => {
    const action = {
      kind: 'auth-login' as const, noticeId: 'notice-web',
      backend: 'pi' as const, provider: 'deepseek', authType: 'api_key' as const,
    };
    const renderer = create(
      <LangProvider>
        <ChatNotice
          level="error" text="Authentication expired" authAction={action}
        />
      </LangProvider>,
    );

    const button = renderer.root.findByType('button');
    act(() => { button.props.onClick(); });
    expect(button.children).toEqual(['Log in again']);
    expect(openLogin).toHaveBeenCalledWith(action);
    expect(JSON.stringify(renderer.toJSON())).not.toContain('notice-web');
  });
});

const claudeUpdate = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('@/features/claude-code-update/useClaudeCodeUpdate', () => ({
  useClaudeCodeUpdate: () => ({ status: undefined, busy: false, check: vi.fn(), update: claudeUpdate.update }),
}));

describe('ChatNotice Claude Code update', () => {
  it('offers the update on an outdated-CLI error card without needing a session handler', () => {
    const renderer = create(
      <LangProvider>
        <ChatNotice level="error" text="API Error: 400 Claude Code 2.1.280 does not support this model"
          noticeAction={{ kind: 'update-claude-code', required: '2.1.290' }} />
      </LangProvider>,
    );
    const button = renderer.root.findByProps({ 'data-notice-action': 'update-claude-code' });
    expect(button.children).toEqual(['Update Claude Code']);
    act(() => { button.props.onClick(); });
    expect(claudeUpdate.update).toHaveBeenCalledTimes(1);
  });
});
