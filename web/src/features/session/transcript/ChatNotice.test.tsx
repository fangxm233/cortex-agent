import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import { ChatNotice } from './ChatNotice';

describe('ChatNotice', () => {

  it('invokes the one-click auth action without rendering its metadata', () => {
    const action = {
      kind: 'auth-login' as const, noticeId: 'notice-web',
      backend: 'pi' as const, provider: 'deepseek', authType: 'api_key' as const,
    };
    const onAuthAction = vi.fn();
    const renderer = create(
      <LangProvider>
        <ChatNotice
          level="error" text="Authentication expired" authAction={action}
          authActionLabel="Log in again" onAuthAction={onAuthAction}
        />
      </LangProvider>,
    );

    const button = renderer.root.findByType('button');
    act(() => { button.props.onClick(); });
    expect(onAuthAction).toHaveBeenCalledWith(action);
    expect(JSON.stringify(renderer.toJSON())).not.toContain('notice-web');
  });
});
