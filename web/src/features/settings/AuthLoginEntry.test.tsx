// input:  desktop PlatformPanel, vocabulary, and login callback
// output: reachable desktop authentication entry regression
// pos:    Verifies Settings exposes the shared LoginFlow modal
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ConfigSnapshot } from '@cortex-agent/ui-contract';
import { LangProvider } from '@/i18n';
import { PlatformPanel } from './SettingsPanels';

const snapshot: ConfigSnapshot = {
  budget: null,
  profiles: null,
  machines: [],
  mcp: null,
  threadTemplates: { agents: [], templates: [], shells: [] },
  hooks: [],
  env: [],
};

describe('desktop authentication settings entry', () => {
  it('renders a reachable control that opens the shared LoginFlow UI', () => {
    const html = renderToStaticMarkup(
      <LangProvider><PlatformPanel snapshot={snapshot} onOpenLogin={() => {}} /></LangProvider>,
    );

    expect(html).toContain('<button type="button" data-auth-login-entry="desktop"');
    expect(html).toContain('Backend login');
  });
});
