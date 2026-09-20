// input:  platform writer hook and mocked direct tRPC client
// output: serialization, redacted feedback and refresh-failure tests
// pos:    Tests credential writes without mutation-cache retention
// >>> Once updated, update this header and parent CORTEX.md <<<

import { act, create } from 'react-test-renderer';
import { beforeEach, expect, test, vi } from 'vitest';
import { usePlatformSettings } from './usePlatformSettings';

const calls = vi.hoisted(() => ({ connection: vi.fn(), runtime: vi.fn(), refresh: vi.fn() }));
const queryFilter = vi.hoisted(() => vi.fn(() => ({})));
vi.mock('@/lib/trpc', () => ({
  useTRPCClient: () => ({ config: { setPlatform: { mutate: calls.connection }, set: { mutate: calls.runtime } } }),
  useTRPC: () => ({ config: { get: { queryFilter } } }),
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: calls.refresh }) }));
let writer: ReturnType<typeof usePlatformSettings>;
function Harness() { writer = usePlatformSettings(); return null; }
beforeEach(() => {
  vi.clearAllMocks(); calls.connection.mockResolvedValue({}); calls.runtime.mockResolvedValue({}); calls.refresh.mockResolvedValue({});
});

test('serializes writes and sends runtime null clears without modifying credentials', async () => {
  const view = create(<Harness />);
  let finish!: () => void;
  calls.connection.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  let first!: Promise<boolean>;
  act(() => { first = writer.saveConnection({ platform: 'feishu', fields: { FEISHU_APP_SECRET: 'test-secret' } }); });
  expect(writer.pending).toBe(true);
  expect(await writer.saveRuntime({ feishuAdminChannel: null })).toBe(false);
  expect(calls.runtime).not.toHaveBeenCalled();
  await act(async () => { finish(); await first; });
  await act(async () => { await writer.saveRuntime({ feishuAdminChannel: null }); });
  expect(calls.runtime).toHaveBeenCalledWith({ section: 'settings', value: { feishuAdminChannel: null } });
  expect(writer.pending).toBe(false);
  view.unmount();
});

test('write failure is fixed feedback; successful write with failed refresh still clears secret drafts', async () => {
  const view = create(<Harness />);
  calls.connection.mockRejectedValueOnce(new Error('never-show-secret'));
  await act(async () => { expect(await writer.saveConnection({ platform: 'slack', fields: {} })).toBe(false); });
  expect(writer.feedback).toBe('failed');
  calls.refresh.mockRejectedValueOnce(new Error('refresh failed'));
  await act(async () => { expect(await writer.saveConnection({ platform: 'slack', fields: {} })).toBe(true); });
  expect(writer.feedback).toBe('refreshFailed');
  view.unmount();
});
