// input:  ChatNotice levels and caller-provided text
// output: semantic notice roles, levels, and auth activation
// pos:    Shared chat-notice behavior contract
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import { ChatNotice, noticeTone } from './ChatNotice';

describe('ChatNotice', () => {
  it.each([
    ['info', 'status'],
    ['warning', 'alert'],
    ['error', 'alert'],
  ] as const)('maps %s notices to the expected semantic role', (level, role) => {
    const text = `notice:${level}`;
    const html = renderToStaticMarkup(<ChatNotice level={level} text={text} />);

    expect(html).toContain(`data-chat-notice="${level}"`);
    expect(html).toContain(`role="${role}"`);
    expect(html).toContain(text);
  });

  it('invokes the notice action and labels it for the reader', () => {
    const onNoticeAction = vi.fn();
    const renderer = create(
      <LangProvider>
        <ChatNotice
          level="warning" text="Rate limited"
          noticeAction={{ kind: 'cancel-resume' }} onNoticeAction={onNoticeAction}
        />
      </LangProvider>,
    );

    const button = renderer.root.findByType('button');
    expect(button.props.children).toBeTruthy();
    act(() => { button.props.onClick(); });
    expect(onNoticeAction).toHaveBeenCalledWith({ kind: 'cancel-resume' });
  });

  it('renders no action button when the notice carries none', () => {
    const html = renderToStaticMarkup(<ChatNotice level="warning" text="Rate limited" />);
    expect(html).not.toContain('<button');
  });

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

  it('exposes the shared level tones for card badges (one token set per level)', () => {
    const levels = ['info', 'warning', 'error'] as const;
    const fgs = levels.map((level) => noticeTone(level).fg);
    for (const fg of fgs) expect(fg).toMatch(/^var\(--proto-/);
    expect(new Set(fgs).size).toBe(3);
  });
});
