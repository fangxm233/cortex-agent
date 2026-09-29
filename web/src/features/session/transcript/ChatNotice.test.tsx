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
