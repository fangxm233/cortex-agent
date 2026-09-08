// input:  setup view, controller and mocked login modal
// output: continuation, skip and login refresh UI regressions
// pos:    Standalone provider setup interaction tests
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { en } from '@/i18n/vocab';
import { ProviderSetupView } from './ProviderSetupPage';
import { ProviderSetupController } from './provider-setup';
vi.mock('@/i18n', () => ({ useVocab: () => en }));
vi.mock('@/design', () => ({ Button: (props: object) => <button {...props} /> }));
vi.mock('@/features/auth/LoginFlowModal', () => ({ LoginFlowModal: (props: object) => <aside {...props} /> }));
vi.mock('@/lib/trpc', () => ({ useTRPCClient: vi.fn() }));
it('always offers warned skip, disables unready continuation and refreshes login success', async () => {
  const sync = vi.fn().mockResolvedValue({ configured: false, reason: 'no-endpoints' });
  const controller = new ProviderSetupController({
    status: async () => ({ accounts: [], piRuntime: { available: true, version: null, entry: null, error: null }, generatedAt: '' }),
    config: async () => ({ profiles: null }), sync, select: vi.fn(), claude: vi.fn(), install: vi.fn(), canInstall: () => false,
  });
  const leave = vi.fn();
  let view!: ReturnType<typeof create>;
  await act(async () => { await controller.load(); view = create(<ProviderSetupView controller={controller} leave={leave} />); });
  expect(view.root.findByProps({ 'data-action': 'setup-continue' }).props.disabled).toBe(true);
  expect(JSON.stringify(view.toJSON())).toContain(en.setupSkipWarning);
  act(() => view.root.findByProps({ 'data-action': 'setup-skip' }).props.onClick());
  expect(leave).toHaveBeenCalledTimes(1);
  await act(async () => view.root.findByType('aside').props.onFlowStateChange({ step: 'done', flowId: 'login' }));
  expect(sync).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(view.toJSON())).toContain('no-endpoints');
  view.unmount();
});
