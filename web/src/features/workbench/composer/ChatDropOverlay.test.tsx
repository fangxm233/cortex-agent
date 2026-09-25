import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import { ChatDropOverlay } from './ChatDropOverlay';

vi.mock('react-dom', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-dom')>(),
  createPortal: (node: unknown) => node,
}));

const pane = {} as HTMLElement;

function render(target: HTMLElement | null, fileCount: number, attachedCount: number): string {
  return renderToStaticMarkup(
    <LangProvider>
      <ChatDropOverlay target={target} fileCount={fileCount} attachedCount={attachedCount} />
    </LangProvider>,
  );
}

describe('ChatDropOverlay', () => {
  it('covers the pane without intercepting the drag', () => {
    const html = render(pane, 2, 0);
    expect(html).toContain('data-chat-drop-overlay');
    expect(html).toContain('position:absolute');
    expect(html).toContain('pointer-events:none');
    expect(html).toMatch(/2/);
  });

  it('reports the resulting attachment count when files are already attached', () => {
    expect(render(pane, 2, 3)).toMatch(/3 → 5/);
  });

  it('renders nothing before the drop target mounts', () => {
    expect(render(null, 1, 0)).toBe('');
  });
});
