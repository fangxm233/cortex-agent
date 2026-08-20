// input:  TemplateDetailPane, language provider, ThreadTemplateDetail fixtures
// output: parse-error, mutation-guard, validation, and path-safety regressions
// pos:    Statically verifies thread-template editor safeguards
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

describe('body tab', () => {
  it('surfaces a parse error and blocks the save button', () => {
    const html = render({ text: '{ nope', loaded: '{}' });
    expect(html).toContain('data-banner="danger"');
    // The hint tells the user why the save is unavailable rather than silently disabling it.
    expect(html).toContain('data-save-hint');
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

describe('create mode', () => {
  it('rejects a name that could escape the config directory', () => {
    const html = render({ creating: { kind: 'agent' }, draftName: '../evil', detail: null, selection: null });
    expect(html).toContain('data-banner="danger"');
  });
});
