import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard';

afterEach(() => { vi.unstubAllGlobals(); });

function fakeDocument(execResult: boolean) {
  const attached: object[] = [];
  const area = {
    value: '', style: { cssText: '' },
    setAttribute: vi.fn(), select: vi.fn(), setSelectionRange: vi.fn(),
    remove: vi.fn(() => { attached.splice(attached.indexOf(area), 1); }),
  };
  const doc = {
    activeElement: null,
    body: { appendChild: vi.fn((node: object) => { attached.push(node); }) },
    createElement: vi.fn(() => area),
    execCommand: vi.fn((_command: string) => execResult),
  };
  vi.stubGlobal('document', doc);
  return { doc, area, attached };
}

describe('copyText', () => {
  it('uses navigator.clipboard when available', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { doc } = fakeDocument(true);
    await expect(copyText('hi')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hi');
    expect(doc.execCommand).not.toHaveBeenCalled();
  });

  it('falls back to execCommand in an insecure context', async () => {
    vi.stubGlobal('navigator', {});
    const { doc, area, attached } = fakeDocument(true);
    await expect(copyText('hi')).resolves.toBe(true);
    expect(area.value).toBe('hi');
    expect(doc.execCommand).toHaveBeenCalledWith('copy');
    expect(attached).toHaveLength(0);
  });

  it('reports failure when neither path copies', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => { throw new Error('denied'); } } });
    fakeDocument(false);
    await expect(copyText('hi')).resolves.toBe(false);
  });
});
