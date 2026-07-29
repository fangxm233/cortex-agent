// input:  HooksPanel, language provider, mounted-hook DTO fixture
// output: desktop mounted-hook rendering regression
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

describe('HooksPanel', () => {
  it('renders mounted hook identity, event, state, and source without script filenames', () => {
    const html = renderToStaticMarkup(
      <LangProvider><HooksPanel snapshot={snapshot} /></LangProvider>,
    );

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
});
