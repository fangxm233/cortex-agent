// input:  HooksPanel, language provider, mounted-hook DTO fixture
// output: desktop mounted-hook and empty-state regressions
// pos:    Verifies settings shows registry state instead of scripts
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ConfigSnapshot } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';
import { HooksPanel } from './SettingsPanels';

const snapshot: ConfigSnapshot = {
  budget: null,
  profiles: null,
  machines: [],
  mcp: null,
  threadTemplates: { agents: [], templates: [], shells: [] },
  hooks: [
    { id: 'managed-hook', event: 'agent:pre-tool', enabled: true, source: 'managed' },
    { id: 'user-hook', event: 'pi:message_end', enabled: false, source: 'user' },
    { id: 'template:review:end', event: 'cortex:thread.end', enabled: true, source: 'template-scoped' },
  ],
  env: [],
};

function renderHooks(value: ConfigSnapshot): string {
  return renderToStaticMarkup(
    <LangProvider><HooksPanel snapshot={value} /></LangProvider>,
  );
}

describe('HooksPanel', () => {
  it('renders mounted hook identity, event, state, and source without script filenames', () => {
    const html = renderHooks(snapshot);

    for (const value of [
      'managed-hook', 'agent:pre-tool', 'managed', 'Enabled',
      'user-hook', 'pi:message_end', 'user', 'Disabled',
      'template:review:end', 'cortex:thread.end', 'template-scoped',
    ]) {
      expect(html).toContain(value);
    }
    expect(html).not.toContain('hooks/*.mjs');
    expect(html).not.toContain('my-hook.mjs');
  });

  it('renders the localized empty state without mounted-hook rows', () => {
    const html = renderHooks({ ...snapshot, hooks: [] });

    expect(html).toContain('No mounted hooks');
    for (const id of ['managed-hook', 'user-hook', 'template:review:end']) {
      expect(html).not.toContain(id);
    }
  });
});
