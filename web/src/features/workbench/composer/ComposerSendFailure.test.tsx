import { useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { TRPCClientError } from '@trpc/client';
import { LangProvider, useSetLang } from '@/i18n';
import type { Lang } from '@/i18n/lang';
import { HttpTransportError, type HttpTransportErrorKind } from '@/lib/http-transport';
import { ComposerSendFailure } from './ComposerSendFailure';

function Language({ lang }: { lang: Lang }) {
  const setLang = useSetLang();
  useEffect(() => setLang(lang), [lang, setLang]);
  return null;
}

function renderFailure(error: Error, lang: Lang): string {
  let tree!: ReactTestRenderer;
  act(() => { tree = create(
    <LangProvider><Language lang={lang} /><ComposerSendFailure error={error} /></LangProvider>,
  ); });
  const text = tree.root.findByProps({ role: 'alert' }).children.join('');
  act(() => tree.unmount());
  return text;
}

const messages: [HttpTransportErrorKind, string, string][] = [
  ['connection', 'Unable to connect to Cortex right now. Please try again later.', '暂时无法连接 Cortex，请稍后重试。'],
  ['authentication', 'Authentication failed. Please check your login status or connection credentials.', '身份验证失败，请检查登录状态或连接凭据。'],
  ['access', 'Access denied. Please check your permissions.', '访问被拒绝，请检查访问权限。'],
  ['unexpected', 'Unexpected server response. Please try again later.', '服务器响应异常，请稍后重试。'],
];

describe('ComposerSendFailure', () => {
  it.each(messages)('localizes typed %s errors through tRPC causes', (kind, en, zh) => {
    const error = TRPCClientError.from(new HttpTransportError(kind));
    expect(renderFailure(error, 'en')).toBe(`Send failed · message restored: ${en}`);
    expect(renderFailure(error, 'zh')).toBe(`发送失败 · 消息已恢复: ${zh}`);
  });

  it.each(['Failed to fetch: business rule', '401 <html> model output', 'offline'])('preserves untyped error text: %s', (message) => {
    const error = new Error(message);
    expect(renderFailure(error, 'en')).toBe(`Send failed · message restored: ${message}`);
    expect(renderFailure(error, 'zh')).toBe(`发送失败 · 消息已恢复: ${message}`);
  });
});
