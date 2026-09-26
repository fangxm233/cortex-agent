import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('@/design/DesktopUpdateFrame', () => ({
  DesktopUpdateFrame: (props: {
    title: string;
    summary: string;
    descriptionId: string;
    description: ReactNode;
    onDismiss: () => void;
    children: ReactNode;
  }) => (
    <section role="dialog" aria-label={props.title}>
      <button type="button" aria-label="frame-dismiss" onClick={props.onDismiss} />
      <h1>{props.title}</h1>
      <div data-summary="">{props.summary}</div>
      <p id={props.descriptionId}>{props.description}</p>
      {props.children}
    </section>
  ),
}));

import { AppUpdateDialog } from '@/features/app-update/AppUpdateDialog';
import { HotUpdateDialog } from '@/features/hot-update/HotUpdateDialog';
import { MAppUpdateDialog } from '@/mobile/screens/MAppUpdateDialog';
import { MHotUpdateDialog } from '@/mobile/screens/MHotUpdateDialog';
import { LangProvider, useSetLang } from '@/i18n';
import { serverUpdateVisible } from './useServerUpdate';
import { ServerUpdateDialog } from './ServerUpdateDialog';

function TextHarness({ children }: { children: ReactNode }) {
  const setLang = useSetLang();
  return (
    <>
      <button type="button" data-lang="en" onClick={() => setLang('en')}>en</button>
      <button type="button" data-lang="zh" onClick={() => setLang('zh')}>zh</button>
      {children}
    </>
  );
}

function nodeText(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (typeof node === 'object' && 'children' in node) {
    return nodeText((node as { children?: unknown }).children);
  }
  return '';
}

function allText(renderer: ReactTestRenderer): string {
  return nodeText(renderer.toJSON());
}

function buttons(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType('button');
}

function clickCallback(renderer: ReactTestRenderer, callback: () => void) {
  const button = buttons(renderer).find((candidate) => candidate.props.onClick === callback);
  expect(button).toBeTruthy();
  act(() => { button!.props.onClick(); });
}

describe('server update visibility', () => {
  it('hides only on idle, or when this version was dismissed', () => {
    expect(serverUpdateVisible({ available: null, state: 'idle' }, null)).toBe(false);
    expect(serverUpdateVisible({ available: '2026.9.20', state: 'prompting' }, null)).toBe(true);
    expect(serverUpdateVisible({ available: '2026.9.20', state: 'prompting' }, '2026.9.20')).toBe(false);
    expect(serverUpdateVisible({ available: '2026.9.21', state: 'prompting' }, '2026.9.20')).toBe(true);
  });
});

describe('localized update prompts', () => {
  it('switches the real desktop and mobile server/app/hot prompts through LangProvider', async () => {
    const serverApply = vi.fn();
    const serverSkip = vi.fn();
    const serverDismiss = vi.fn();
    const appInstall = vi.fn();
    const appSkip = vi.fn();
    const appDismiss = vi.fn();
    const hotApply = vi.fn();
    const hotDismiss = vi.fn();
    const mobileInstall = vi.fn();
    const mobileSkip = vi.fn();
    const mobileDismiss = vi.fn();
    const mobileHotApply = vi.fn();
    const mobileHotDismiss = vi.fn();

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <LangProvider>
          <TextHarness>
            <ServerUpdateDialog
              status={{ available: '2026.9.20', state: 'prompting' }}
              busy={false}
              onApply={serverApply}
              onSkip={serverSkip}
              onDismiss={serverDismiss}
            />
            <AppUpdateDialog
              update={{ version: '2026.9.21', kind: 'appimage', apply: 'prompt' }}
              busy={false}
              error={null}
              onInstall={appInstall}
              onSkip={appSkip}
              onDismiss={appDismiss}
            />
            <HotUpdateDialog
              update={{ version: 'abcdef123456', fromVersion: '123456abcdef' }}
              onApply={hotApply}
              onDismiss={hotDismiss}
            />
            <MAppUpdateDialog
              update={{ version: '2026.9.22', kind: 'apk', apply: 'prompt' }}
              busy={false}
              error={null}
              onInstall={mobileInstall}
              onSkip={mobileSkip}
              onDismiss={mobileDismiss}
            />
            <MHotUpdateDialog
              update={{ version: 'fedcba654321', fromVersion: '654321fedcba' }}
              onApply={mobileHotApply}
              onDismiss={mobileHotDismiss}
            />
          </TextHarness>
        </LangProvider>,
      );
    });

    await act(async () => { renderer.root.findByProps({ 'data-lang': 'en' }).props.onClick(); });

    expect(allText(renderer)).not.toMatch(/\p{Script=Han}/u);
    expect(allText(renderer)).toContain('Update available');
    expect(allText(renderer)).toContain('Update to 2026.9.20?');
    expect(allText(renderer)).toContain('Restart to update');
    expect(allText(renderer)).toContain('Restart app');
    expect(allText(renderer)).toContain('Follow the system prompts to install.');
    expect(allText(renderer)).toContain('Exit app');

    for (const callback of [
      serverApply, serverSkip, serverDismiss, appInstall, appSkip, appDismiss,
      hotApply, hotDismiss, mobileInstall, mobileSkip, mobileDismiss, mobileHotApply, mobileHotDismiss,
    ]) {
      clickCallback(renderer, callback);
      expect(callback).toHaveBeenCalledTimes(1);
    }

    await act(async () => { renderer.root.findByProps({ 'data-lang': 'zh' }).props.onClick(); });

    expect(allText(renderer)).not.toContain('全程只需这一次确认');
    expect(allText(renderer)).not.toContain('服务端自行安装并重启');
    expect(allText(renderer)).toContain('新版本可用');
    expect(allText(renderer)).toContain('更新到 2026.9.20？');
    expect(allText(renderer)).toContain('重启更新');
    expect(allText(renderer)).toContain('重启 App');
    expect(allText(renderer)).toContain('请按系统提示完成安装。');
    expect(allText(renderer)).toContain('退出 App');
    expect(allText(renderer)).toContain('忽略');
  });

  it('keeps failures actionable without the old long copy or npm command', async () => {
    const onDismiss = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <LangProvider>
          <TextHarness>
            <ServerUpdateDialog
              status={{ available: '2026.9.20', state: 'failed', error: 'socket hang up' }}
              busy={false}
              onApply={vi.fn()}
              onSkip={vi.fn()}
              onDismiss={onDismiss}
            />
          </TextHarness>
        </LangProvider>,
      );
    });

    await act(async () => { renderer.root.findByProps({ 'data-lang': 'en' }).props.onClick(); });

    expect(allText(renderer)).toContain('Update failed');
    expect(allText(renderer)).toContain('socket hang up');
    expect(allText(renderer)).not.toContain('npm install -g @cortex-agent/server@latest');
    expect(allText(renderer)).not.toContain('服务端仍在运行旧版本');

    await act(async () => { renderer.root.findByProps({ 'data-lang': 'zh' }).props.onClick(); });

    expect(allText(renderer)).toContain('更新失败');
    expect(allText(renderer)).toContain('更新未完成，稍后可重试。');
    expect(allText(renderer)).toContain('socket hang up');
    expect(allText(renderer)).not.toContain('npm install -g @cortex-agent/server@latest');
    expect(allText(renderer)).not.toContain('服务端仍在运行旧版本');

    clickCallback(renderer, onDismiss);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
