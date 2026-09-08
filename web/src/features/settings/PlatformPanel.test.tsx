// input:  platform panel, redacted fixtures and save callbacks
// output: credential, routing, skill and failure-state regressions
// pos:    Functional platform editor interaction tests
// >>> Once updated, update this header and parent CORTEX.md <<<

import { act, create } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import type { ConfigSnapshot, PlatformSettingsSnapshot } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';
import { PlatformPanelView } from './PlatformPanel';
import { connectionPatch } from './platform-settings-vm';

const platform: PlatformSettingsSnapshot = {
  platform: 'feishu', enabled: true, runtimeEnabled: true, missing: [], pendingRestart: false,
  fields: [
    { key: 'FEISHU_APP_ID', secret: false, value: 'cli_demo', present: true, runtimePresent: true, differs: false },
    { key: 'FEISHU_APP_SECRET', secret: true, present: true, runtimePresent: true, differs: false },
    { key: 'FEISHU_DOMAIN', secret: false, value: 'feishu', present: false, runtimePresent: false, differs: false },
  ],
};
const snapshot: ConfigSnapshot = {
  platforms: [platform], budget: null, profiles: null, machines: [], mcp: null, hooks: [], env: [],
  threadTemplates: { agents: [], templates: [], shells: [] },
  settings: [{ key: 'feishuSkillsInWeb', value: false, source: 'default' },
    { key: 'feishuAdminChannel', value: 'oc_old', source: 'file' }],
};
function props(overrides: Record<string, unknown> = {}) {
  return { snapshot, secure: true, pending: false, feedback: null,
    saveConnection: vi.fn(async () => true), saveRuntime: vi.fn(async () => true), onDirtyChange: vi.fn(), ...overrides };
}
function render(p: ReturnType<typeof props>) {
  return create(<LangProvider><PlatformPanelView {...p} /></LangProvider>);
}

test('blank secrets preserve existing values and explicit clear is a null patch', () => {
  expect(connectionPatch(platform, true, { FEISHU_APP_SECRET: '' }).fields).toEqual({});
  expect(connectionPatch(platform, false, { FEISHU_APP_SECRET: null })).toEqual({
    platform: 'feishu', enabled: false, fields: { FEISHU_APP_SECRET: null },
  });
});

test('typing a replacement submits the exact patch and clears the password input after save', async () => {
  const p = props(); const view = render(p);
  const input = () => view.root.findByProps({ name: 'FEISHU_APP_SECRET' });
  expect(input().props.value).toBe('');
  act(() => input().props.onChange({ target: { value: 'replacement-demo' } }));
  await act(async () => { view.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
  expect(p.saveConnection).toHaveBeenCalledWith({ platform: 'feishu', fields: { FEISHU_APP_SECRET: 'replacement-demo' } });
  expect(input().props.value).toBe('');
  view.unmount();
});

test('failed saves retain the draft for retry and never display raw error content', async () => {
  const p = props({ saveConnection: vi.fn(async () => false), feedback: 'failed' });
  const view = render(p); const input = view.root.findByProps({ name: 'FEISHU_APP_SECRET' });
  act(() => input.props.onChange({ target: { value: 'retry-demo' } }));
  await act(async () => { view.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
  expect(view.root.findByProps({ name: 'FEISHU_APP_SECRET' }).props.value).toBe('retry-demo');
  expect(view.root.findByProps({ role: 'status' }).children.join('')).not.toContain('retry-demo');
  view.unmount();
});

test('skill and destination controls write only their own runtime settings', async () => {
  const p = props(); const view = render(p);
  const switches = view.root.findAllByProps({ type: 'checkbox' });
  await act(async () => { switches[1].props.onChange({ target: { checked: true } }); });
  expect(p.saveRuntime).toHaveBeenLastCalledWith({ feishuSkillsInWeb: true });
  act(() => view.root.findByProps({ name: 'feishuAdminChannel' }).props.onChange({ target: { value: 'oc_new' } }));
  const save = view.root.findAllByType('button').find(button => String(button.children).includes('destination') || String(button.children).includes('通知目标'))!;
  await act(async () => { save.props.onClick(); });
  expect(p.saveRuntime).toHaveBeenLastCalledWith({ feishuAdminChannel: 'oc_new' });
  view.unmount();
});

test('insecure transport disables credential entry but leaves runtime preferences usable', () => {
  const view = render(props({ secure: false }));
  expect(view.root.findByProps({ name: 'FEISHU_APP_SECRET' }).props.disabled).toBe(true);
  expect(view.root.findByProps({ name: 'feishuAdminChannel' }).props.disabled).toBe(false);
  expect(view.root.findAllByProps({ role: 'alert' })).toHaveLength(1);
  view.unmount();
});

test('old server and pending-save states are honest and contain no placeholder reconnect', () => {
  const html = renderToStaticMarkup(<LangProvider><PlatformPanelView {...props({ snapshot: { ...snapshot, platforms: undefined } })} /></LangProvider>);
  expect(html).toMatch(/Upgrade|升级/);
  const ready = renderToStaticMarkup(<LangProvider><PlatformPanelView {...props({ feedback: 'saved' })} /></LangProvider>);
  expect(ready).toContain('daemon');
  expect(ready).not.toContain('data-reconnect');
  expect(ready).not.toContain('CORTEX_TUI');
});
