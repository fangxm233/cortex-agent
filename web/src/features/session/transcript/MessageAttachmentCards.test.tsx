import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import type { AttachmentMeta } from '@/features/attachments/types';
import { AgentFileGroup, AttachmentCard } from './MessageAttachmentCards';

const openDoc = vi.fn();
const download = vi.fn();
vi.mock('@/features/media/useWorkspaceObjectUrl', () => ({ useWorkspaceObjectUrl: () => null }));
vi.mock('@/features/media/useDownloadFile', () => ({ useDownloadFile: () => download }));
vi.mock('@/features/media/MediaViewer', () => ({ useMediaViewer: () => ({ openMedia: vi.fn() }) }));
vi.mock('@/features/media/DocViewer', () => ({ useDocViewer: () => ({ openDoc }) }));

const csv: AttachmentMeta = {
  name: 'sweep-results.csv', path: 'workspace/tmp/optimizer-study/sweep-results.csv', type: 'file', size: 4200, mimeType: 'text/csv',
};

const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
const fonts = (node: ReactTestInstance): string[] =>
  node.findAll((n) => typeof n.props.style?.font === 'string').map((n) => n.props.style.font as string);

function render(content: JSX.Element): ReactTestRenderer {
  let view!: ReactTestRenderer;
  act(() => { view = create(<LangProvider>{content}</LangProvider>); });
  return view;
}

describe('attachment file rows', () => {
  it('draws an agent file as a quiet row: name, type word and size, a text action', () => {
    const view = render(<AgentFileGroup attachments={[csv]} />);
    const row = view.root.findByProps({ 'data-attachment-file': 'agent' });
    // The path lives only in the tooltip; the row reads name, then "CSV · 4.1 KB".
    expect(row.props.title).toBe(csv.path);
    expect(text(row)).not.toContain('workspace/');
    expect(text(row)).toContain('sweep-results.csv');
    expect(text(row)).toContain('CSV · 4.1 KB');
    expect(fonts(row).some((font) => font.includes('Mono'))).toBe(false);
    const open = row.findAllByType('button').find((b) => text(b) === 'Open')!;
    expect(open.props.style).toMatchObject({ background: 'transparent', color: 'var(--proto-accent)' });
    expect(text(row)).not.toContain('↗');
    act(() => open.props.onClick());
    expect(openDoc).toHaveBeenCalledWith(expect.objectContaining({ name: csv.name, path: csv.path }));
    act(() => row.findByProps({ 'aria-label': 'Download' }).props.onClick());
    expect(download).toHaveBeenCalledWith(csv.path, csv.name);
    act(() => view.unmount());
  });

  it('draws a user upload as the same row in a hairline capsule beside the bubble', () => {
    const view = render(<AttachmentCard a={csv} />);
    const card = view.root.findByProps({ 'data-attachment-file': 'user' });
    expect(card.props.title).toBe(csv.path);
    expect(text(card)).toBe('sweep-results.csvCSV · 4.1 KB');
    expect(fonts(card).some((font) => font.includes('Mono'))).toBe(false);
    act(() => view.unmount());
  });
});
