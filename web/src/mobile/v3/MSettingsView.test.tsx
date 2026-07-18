import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MSettingsView, type MSettingsCopy } from './MSettingsView';
import type { MSettingsVm } from './m-settings-vm';

const copy: MSettingsCopy = {
  title: '设置',
  daemonStatus: 'daemon · 已连接',
  daemon: 'Daemon',
  profileTitle: 'Profile（全局默认）',
  profileTail: '会话级切换在 chat 内 chip',
  switchLabel: '切换',
  theme: '主题',
  themeLight: '浅色',
  themeDark: '深色',
  budget: '预算',
  budgetUnit: '日',
  notify: '通知',
  notifySub: '推送开 · 长任务 > 10m · 审批即时',
  autoResume: '限额自动续跑',
  autoResumeSub: 'rate-limit 解除后自动恢复线程',
  language: '语言',
  platform: 'Platform',
  desktopEdit: '桌面编辑',
  templates: 'Thread templates',
  hooks: 'Hooks · 三层只读',
  footerBrand: 'cortex mobile',
  footerHot: '配置热更新 · 免重启',
};

function vm(over: Partial<MSettingsVm> = {}): MSettingsVm {
  return {
    daemonHost: null,
    profileName: 'default',
    profileModel: 'sonnet-4.5',
    budgetSpendLabel: '$4.21 / $10.00',
    budgetBarPct: '42%',
    notifyOn: true,
    autoResumeOn: true,
    platforms: ['slack', 'feishu'],
    templatesCount: 4,
    ...over,
  };
}

function render(over: Partial<MSettingsVm> = {}) {
  return renderToStaticMarkup(
    <MSettingsView
      vm={vm(over)}
      copy={copy}
      lang="zh"
      onSetLang={() => {}}
      theme="light"
      onSetTheme={() => {}}
      onBack={() => {}}
      onOpenDaemon={() => {}}
    />,
  );
}

describe('MSettingsView', () => {
  it('renders the drill header title + the daemon connected status', () => {
    const html = render();
    expect(html).toContain('设置');
    expect(html).toContain('daemon · 已连接');
  });

  it('renders the real default profile + model in the profile sub, with the 切换 accent', () => {
    const html = render();
    expect(html).toContain('default · sonnet-4.5 · 会话级切换在 chat 内 chip');
    expect(html).toContain('切换');
  });

  it('omits the daemon host line when there is no host (never fabricated)', () => {
    const html = render({ daemonHost: null });
    // no scheme mock host/uptime leaks
    expect(html).not.toContain('home-server');
    expect(html).not.toContain('uptime');
  });

  it('renders the real budget spend label + bar width', () => {
    const html = render();
    expect(html).toContain('$4.21 / $10.00');
    expect(html).toContain('width:42%');
  });

  it('reflects env presence on the (read-only) toggles', () => {
    const on = render({ notifyOn: true, autoResumeOn: true });
    expect(on).toContain('aria-checked="true"');
    expect(on).toContain('aria-readonly');
    const off = render({ notifyOn: false, autoResumeOn: false });
    expect(off).toContain('aria-checked="false"');
  });

  it('renders the present platforms + real template count + desktop-edit pills', () => {
    const html = render();
    expect(html).toContain('Platform（slack, feishu）');
    expect(html).toContain('Thread templates · 4');
    expect(html).toContain('桌面编辑');
    expect(html).toContain('Hooks · 三层只读');
  });

  it('renders Platform bare when no integration keys are present', () => {
    const html = render({ platforms: [] });
    expect(html).toContain('Platform');
    expect(html).not.toContain('（slack');
  });

  it('renders the language row with EN/中 toggle', () => {
    const html = render();
    expect(html).toContain('语言');
    expect(html).toContain('EN');
    expect(html).toContain('中');
  });

  it('renders the theme row with 浅色/深色 toggle', () => {
    const html = render();
    expect(html).toContain('主题');
    expect(html).toContain('浅色');
    expect(html).toContain('深色');
  });

  it('renders the footer brand + hot-reload note without a fabricated version', () => {
    const html = render();
    expect(html).toContain('cortex mobile');
    expect(html).toContain('配置热更新 · 免重启');
    expect(html).not.toContain('v0.4.2');
  });
});
