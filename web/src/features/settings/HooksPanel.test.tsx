// input:  HooksPanelView, language provider, HookDetail fixtures
// output: hook capability, validation, delete, and runner regressions
// pos:    Verifies hook capabilities, interactions and validity state
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { HookDetail, HooksTestReturn } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';

vi.mock('@/design', async importOriginal => ({
  ...await importOriginal<typeof import('@/design')>(),
  Select: ({ options, value, ...props }: any) => (
    <div data-select-control data-select-value={String(value)} {...props}>
      {options.map((option: any) => <span key={String(option.value)}>{option.label}</span>)}
    </div>
  ),
}));

import { HooksPanelView, type HooksPanelViewProps } from './HooksPanel';
import { formStateFromDetail } from './hooks-panel-vm';

function hook(over: Partial<HookDetail> = {}): HookDetail {
  return {
    id: 'sensitive-file-edit',
    event: 'agent:pre-tool',
    matcher: 'Edit|Write',
    matcherFilters: null,
    run: { script: 'sensitive-file-edit.mjs', command: null, timeoutSec: 10 },
    scope: null,
    blocking: null,
    result: null,
    enabled: true,
    source: 'managed',
    version: '2026.7.29',
    fileName: '01-sensitive-file-edit.json',
    order: 0,
    mountsOn: ['claude', 'pi'],
    legalResults: ['none'],
    appliesAt: 'next-agent',
    scriptExists: true,
    editable: false,
    template: null,
    phase: null,
    ...over,
  };
}

const userHook = hook({
  id: 'my-hook',
  source: 'user',
  version: null,
  editable: true,
  fileName: '50-my-hook.json',
  order: 5,
});

function render(over: Partial<HooksPanelViewProps> = {}): string {
  const hooks = over.hooks ?? [hook()];
  const selectedId = over.selectedId !== undefined ? over.selectedId : (hooks[0]?.id ?? null);
  const selected = hooks.find((h) => h.id === selectedId) ?? null;
  const props: HooksPanelViewProps = {
    hooks,
    scripts: [{ name: 'sensitive-file-edit.mjs', usedBy: ['sensitive-file-edit'] }],
    hooksDir: '/hooks',
    filter: 'all',
    search: '',
    selectedId,
    draft: selected ? formStateFromDetail(selected) : null,
    creating: false,
    armedDelete: false,
    saving: false,
    testOpen: false,
    testPayload: '',
    testResult: null,
    testPending: false,
    onFilter: () => {},
    onSearch: () => {},
    onSelect: () => {},
    onStartCreate: () => {},
    onCancelCreate: () => {},
    onDraftChange: () => {},
    onToggleEnabled: () => {},
    onSave: () => {},
    onRevert: () => {},
    onArmDelete: () => {},
    onCancelDelete: () => {},
    onConfirmDelete: () => {},
    onOpenTest: () => {},
    onCloseTest: () => {},
    onTestPayloadChange: () => {},
    onRunTest: () => {},
    ...over,
  };
  return renderToStaticMarkup(
    <LangProvider><HooksPanelView {...props} /></LangProvider>,
  );
}

describe('HooksPanelView / capability by source', () => {
  it('managed shows a persistent inline note and keeps every field but the toggle read-only', () => {
    const html = render({ hooks: [hook({ source: 'managed' })] });
    expect(html).toContain('data-hook-note="managed"');
    expect(html).toContain('hook sync');
    expect(html).toContain('data-hook-toggle');
    // the editable controls are not rendered as inputs for a managed entry
    expect(html).not.toContain('data-hook-field="event"');
    expect(html).not.toContain('data-action="save"');
    expect(html).not.toContain('data-action="arm-delete"');
  });

  it('template-scoped is fully read-only, with no toggle, and points at thread templates', () => {
    const html = render({
      hooks: [hook({
        id: 'template:review:end',
        source: 'template-scoped',
        version: null,
        fileName: null,
        template: 'review',
        phase: 'end',
        event: 'cortex:thread.end',
        mountsOn: ['server'],
      })],
    });
    expect(html).toContain('data-hook-note="template-scoped"');
    expect(html).toContain('Thread templates');
    expect(html).not.toContain('data-hook-toggle');
    expect(html).not.toContain('data-action="save"');
  });

  it('a user entry gets the full editor plus save / revert / delete', () => {
    const html = render({ hooks: [userHook] });
    expect(html).not.toContain('data-hook-note=');
    expect(html).toContain('data-hook-field="event"');
    expect(html).toContain('data-hook-field="script"');
    expect(html).toContain('data-action="save"');
    expect(html).toContain('data-action="revert"');
    expect(html).toContain('data-action="arm-delete"');
    expect(html).toContain('data-hook-toggle');
  });

  it('never renders an editable blocking or version control', () => {
    const blocking = hook({
      ...userHook,
      blocking: { mode: 'webhook', ttlMin: 30 },
    });
    const html = render({ hooks: [blocking] });
    expect(html).not.toContain('data-hook-field="blocking"');
    expect(html).not.toContain('data-hook-field="version"');
    // it is still shown, read-only, because it changes how the hook behaves
    expect(html).toContain('webhook');
  });
});

describe('HooksPanelView / trigger editor', () => {
  it('uses a regex input for non-cortex events and surfaces a live compile error', () => {
    const ok = render({ hooks: [userHook], draft: { ...formStateFromDetail(userHook), matcher: 'Edit|Write' } });
    expect(ok).toContain('data-hook-field="matcher"');
    expect(ok).not.toContain('data-hook-matcher-error');

    const bad = render({ hooks: [userHook], draft: { ...formStateFromDetail(userHook), matcher: 'Edit(' } });
    expect(bad).toContain('data-hook-matcher-error');
  });

  it('uses a key/value filter editor for cortex:* events', () => {
    const cortexUser = hook({
      ...userHook,
      event: 'cortex:thread.end',
      matcher: null,
      matcherFilters: { source: 'task-dispatch' },
      mountsOn: ['server'],
      legalResults: ['none', 'hook-result'],
      appliesAt: 'server-restart',
    });
    const html = render({ hooks: [cortexUser] });
    expect(html).toContain('data-hook-filters-editor');
    expect(html).toContain('source');
    expect(html).toContain('task-dispatch');
    expect(html).not.toContain('data-hook-field="matcher"');
  });
});

describe('HooksPanelView / advanced', () => {
  it('offers only the legal result modes and locks the select when only none is legal', () => {
    const html = render({ hooks: [userHook] });
    expect(html).toContain('data-hook-field="result"');
    expect(html).toContain('data-select-control');
    expect(html).toContain('data-hook-result-locked');
    expect(html).not.toContain('>hook-result<');
    expect(html).not.toContain('>stdout-as-prompt<');
  });

  it('offers the event-specific result mode when the event supports one', () => {
    const cortexUser = hook({
      ...userHook,
      event: 'cortex:thread.end',
      matcher: null,
      mountsOn: ['server'],
      legalResults: ['none', 'hook-result'],
      appliesAt: 'server-restart',
    });
    const html = render({ hooks: [cortexUser] });
    expect(html).toContain('>hook-result<');
    expect(html).not.toContain('>stdout-as-prompt<');
    expect(html).not.toContain('data-hook-result-locked');
  });

});

describe('HooksPanelView / delete', () => {
  it('arms before confirming, never prompting through the browser', () => {
    const armed = render({ hooks: [userHook], armedDelete: true });
    expect(armed).toContain('data-action="confirm-delete"');
    expect(armed).toContain('data-action="cancel-delete"');
    expect(armed).not.toContain('data-action="arm-delete"');

    const idle = render({ hooks: [userHook], armedDelete: false });
    expect(idle).toContain('data-action="arm-delete"');
    expect(idle).not.toContain('data-action="confirm-delete"');
  });
});

describe('HooksPanelView / test runner', () => {
  it('keeps the payload editor closed until Test is opened', () => {
    const html = render({ hooks: [hook()] });
    expect(html).toContain('data-action="open-test"');
    expect(html).not.toContain('data-hook-test-payload');
  });

  it('shows the payload textarea and the run action when open', () => {
    const html = render({
      hooks: [hook()],
      testOpen: true,
      testPayload: '{"tool_name":"Edit"}',
      });
    expect(html).toContain('data-hook-test-payload');
    expect(html).toContain('data-action="run-test"');
    expect(html).toContain('{&quot;tool_name&quot;:&quot;Edit&quot;}');
  });

  it('renders exit code, stdout and stderr inline after a run', () => {
    const result: HooksTestReturn = {
      ok: false, exitCode: 2, stdout: 'out-line', stderr: 'err-line', error: null,
    };
    const html = render({ hooks: [hook()], testOpen: true, testResult: result });
    expect(html).toContain('data-hook-test-result');
    expect(html).toContain('data-hook-test-exit="2"');
    expect(html).toContain('out-line');
    expect(html).toContain('err-line');
  });

  it('surfaces a spawn error that never produced an exit code', () => {
    const result: HooksTestReturn = {
      ok: false, exitCode: null, stdout: '', stderr: '', error: 'spawn failed',
    };
    const html = render({ hooks: [hook()], testOpen: true, testResult: result });
    expect(html).toContain('spawn failed');
  });

  it('warns before running a hook that blocks on a webhook round trip', () => {
    const blocking = hook({ blocking: { mode: 'webhook', ttlMin: 30 } });
    expect(render({ hooks: [blocking], testOpen: true })).toContain('data-hook-blocking-warning');
    expect(render({ hooks: [hook()], testOpen: true })).not.toContain('data-hook-blocking-warning');
  });

  it('flags a payload that is not valid JSON before it is sent', () => {
    const html = render({ hooks: [hook()], testOpen: true, testPayload: '{oops' });
    expect(html).toContain('data-hook-payload-error');
  });
});
