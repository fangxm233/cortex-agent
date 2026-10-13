import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchFileObjectUrl } from '@/lib/files';
import { useWorkspaceObjectUrl } from './useWorkspaceObjectUrl';

vi.mock('@/lib/files', () => ({ fetchFileObjectUrl: vi.fn() }));
const fetchUrl = vi.mocked(fetchFileObjectUrl);
let view: ReactTestRenderer;
let current: string | null;

function Probe({ path }: { path: string | null }) {
  current = useWorkspaceObjectUrl(path);
  return null;
}

beforeEach(() => {
  fetchUrl.mockReset();
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => { act(() => view?.unmount()); vi.restoreAllMocks(); });

describe('workspace preview downloads', () => {
  it('does not download a viewport-gated null path', () => {
    act(() => { view = create(<Probe path={null} />); });
    expect(fetchUrl).not.toHaveBeenCalled();
    expect(current).toBeNull();
  });

  it('aborts the previous download on path change and the current download on unmount', () => {
    fetchUrl.mockImplementation(() => new Promise(() => {}));
    act(() => { view = create(<Probe path="first.png" />); });
    const firstSignal = fetchUrl.mock.calls[0][2];
    expect(firstSignal?.aborted).toBe(false);
    act(() => view.update(<Probe path="second.png" />));
    expect(firstSignal?.aborted).toBe(true);
    const secondSignal = fetchUrl.mock.calls[1][2];
    expect(secondSignal?.aborted).toBe(false);
    act(() => view.unmount());
    expect(secondSignal?.aborted).toBe(true);
  });

  it('revokes a completed object URL when unmounted', async () => {
    fetchUrl.mockResolvedValue('blob:preview');
    await act(async () => { view = create(<Probe path="first.png" />); });
    expect(current).toBe('blob:preview');
    act(() => view.unmount());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  });

  it('revokes a late result even if the fetch ignores cancellation', async () => {
    let resolve!: (value: string) => void;
    fetchUrl.mockImplementation(() => new Promise((done) => { resolve = done; }));
    act(() => { view = create(<Probe path="first.png" />); });
    act(() => view.unmount());
    await act(async () => { resolve('blob:late'); });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:late');
  });
});
