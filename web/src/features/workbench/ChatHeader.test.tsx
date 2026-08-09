// input:  Desktop chat header state and mocked notes provider
// output: Regression checks for header-only navigation controls
// pos:    Desktop chat header layout specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';

vi.mock('@/features/notes/NotesProvider', () => ({
  useNotes: () => ({
    vm: { activeCount: 0 },
    isOpen: false,
    copy: {},
    open: vi.fn(),
    close: vi.fn(),
  }),
}));

import { ChatHeader } from './ChatHeader';

function renderHeader(): string {
  return renderToStaticMarkup(
    <LangProvider>
      <ChatHeader
        title="Session"
        onCmdK={() => {}}
        backendSessionId={null}
        sessionName="cortex-test"
      />
    </LangProvider>,
  );
}

describe('ChatHeader', () => {
  it('omits profile and status controls', () => {
    const html = renderHeader();

    expect(html).not.toContain('data-chip="profile"');
    expect(html).not.toContain('>idle<');
    expect(html).not.toContain('>Running<');
  });
});
