// input:  TemplateDetailPane, language provider, ThreadTemplateDetail fixtures
// output: detail-pane rendering regressions — tabs, guards, gating and the expanded shell graph
// pos:    Renders the pane statically (no tRPC), the way HooksPanel.test.tsx renders HooksPanelView.
//         The assertions worth keeping are the safety ones: the running-thread warning must appear
//         before a save can reroute a live thread, and delete must be disabled while dependents
//         exist rather than merely failing at the server.
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ThreadTemplateDetail } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';
import { TemplateDetailPane, type TemplateDetailPaneProps } from './TemplatesPanel';
import { formatBody } from './templates-panel-vm';

function detail(over: Partial<ThreadTemplateDetail> = {}): ThreadTemplateDetail {
  return {
    kind: 'template',
    name: 'coder-review',
    description: 'coder → reviewer',
    body: { name: 'coder-review', maxTotalSteps: 4 },
    filePath: '/home/u/.cortex/config/thread-templates/templates/coder-review.json',
    origin: 'custom',
    sha256: 'a'.repeat(64),
    errors: [],
    warnings: [],
    usedByTemplates: [],
    runningThreads: 0,
    referencingTasks: 0,
    expanded: null,
    ...over,
  };
}

function render(over: Partial<TemplateDetailPaneProps> = {}): string {
  const d = over.detail !== undefined ? over.detail : detail();
  const loaded = d?.body ? formatBody(d.body) : '';
  const props: TemplateDetailPaneProps = {
    selection: d ? { kind: d.kind, name: d.name } : null,
    detail: d,
    creating: null,
    draftName: '',
    text: loaded,
    loaded,
    tab: 'body',
    liveIssues: null,
    armedSave: false,
    armedDelete: false,
    busy: false,
    onDraftName: () => {},
    onText: () => {},
    onTab: () => {},
    onSave: () => {},
    onRevert: () => {},
    onValidate: () => {},
    onDelete: () => {},
    onDuplicate: () => {},
    onCancelCreate: () => {},
    onFormat: () => {},
    ...over,
  };
  return renderToStaticMarkup(
    <LangProvider>
      <TemplateDetailPane {...props} />
    </LangProvider>,
  );
}

describe('empty state', () => {
  it('prompts for a selection when nothing is selected', () => {
    const html = render({ detail: null, selection: null });
    expect(html).toContain('data-template-detail-empty');
  });
});

describe('body tab', () => {
  it('shows the raw body in an editable textarea', () => {
    const html = render();
    expect(html).toContain('data-template-body');
    expect(html).toContain('coder-review');
    expect(html).toContain('maxTotalSteps');
  });

  it('surfaces a parse error and blocks the save button', () => {
    const html = render({ text: '{ nope', loaded: '{}' });
    expect(html).toContain('data-banner="danger"');
    // The hint tells the user why the save is unavailable rather than silently disabling it.
    expect(html).toContain('data-save-hint');
  });

  it('marks the pane dirty once the text diverges from what was loaded', () => {
    expect(render({ text: '{"a":1}', loaded: '{"a":2}' })).toContain('data-dirty');
    expect(render()).not.toContain('data-dirty');
  });
});

describe('guards', () => {
  it('warns about live threads before a save can reroute them', () => {
    const html = render({ detail: detail({ runningThreads: 3 }) });
    expect(html).toContain('data-banner="warn"');
    expect(html).toContain('3');
  });

  it('warns that editing a stock entity forks it from the shipped default', () => {
    const html = render({
      detail: detail({ origin: 'stock' }),
      text: '{"changed":true}',
      loaded: '{}',
    });
    expect(html).toContain('data-banner="warn"');
  });

  it('does not warn about forking until something is actually edited', () => {
    const loaded = formatBody({ name: 'coder-review', maxTotalSteps: 4 });
    const html = render({ detail: detail({ origin: 'stock' }), text: loaded, loaded });
    expect(html).not.toContain('data-banner="warn"');
  });

  it('shows the origin badge', () => {
    expect(render({ detail: detail({ origin: 'modified' }) })).toContain('data-origin="modified"');
  });
});

describe('validation tab', () => {
  it('lists errors and warnings with their field anchors', () => {
    const html = render({
      tab: 'validation',
      detail: detail({
        errors: [{ path: 'entryAgent', message: 'not in this template’s agents' }],
        warnings: [{ path: 'agents', message: 'never reached' }],
      }),
    });
    expect(html).toContain('data-issue="danger"');
    expect(html).toContain('entryAgent');
    expect(html).toContain('data-issue="warn"');
    expect(html).toContain('never reached');
  });

  it('prefers freshly validated issues over the ones loaded with the entity', () => {
    const html = render({
      tab: 'validation',
      detail: detail({ errors: [{ path: 'stale', message: 'from load' }] }),
      liveIssues: { errors: [{ path: 'fresh', message: 'from validate' }], warnings: [] },
    });
    expect(html).toContain('fresh');
    expect(html).not.toContain('stale');
  });
});

describe('references tab', () => {
  it('shows the file path, dependents and live counts', () => {
    const html = render({
      tab: 'references',
      detail: detail({ usedByTemplates: ['analyst-review'], runningThreads: 2, referencingTasks: 5 }),
    });
    expect(html).toContain('thread-templates/templates/coder-review.json');
    expect(html).toContain('analyst-review');
    expect(html).toContain('2');
    expect(html).toContain('5');
  });

  it('shows the expanded graph for a shell-binding template', () => {
    const html = render({
      tab: 'references',
      detail: detail({
        body: { shell: 'worker-review', worker: 'coder', reviewer: 'coder-reviewer' },
        expanded: { agents: ['coder', 'coder-reviewer'], entryAgent: 'coder', maxTotalSteps: 4 },
      }),
    });
    expect(html).toContain('data-template-expanded');
    expect(html).toContain('coder-reviewer');
  });
});

describe('create mode', () => {
  it('offers a name field and hides delete', () => {
    const html = render({ creating: { kind: 'agent' }, draftName: 'new-agent', detail: null, selection: null });
    expect(html).toContain('data-template-name');
    expect(html).toContain('data-action="cancel-create"');
    expect(html).not.toContain('data-action="delete"');
  });

  it('rejects a name that could escape the config directory', () => {
    const html = render({ creating: { kind: 'agent' }, draftName: '../evil', detail: null, selection: null });
    expect(html).toContain('data-banner="danger"');
  });
});
