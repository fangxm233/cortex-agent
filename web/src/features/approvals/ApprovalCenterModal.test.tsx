// input:  shared approval queue facts plus desktop selection, deny, and toast adapters
// output: desktop feedback handoff, surface-state reset, and toast regressions
// pos:    Desktop approval modal interaction specification
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { act, create } from 'react-test-renderer';
import type { ApprovalInfo } from '@cortex-agent/ui-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalQueue } from './useApprovalQueue';

const adapter = vi.hoisted(() => ({
  approve: vi.fn<(id: string) => Promise<void>>(),
  reject: vi.fn<(id: string, feedback?: string) => Promise<void>>(),
  toast: vi.fn(),
}));

function approval(id: string): ApprovalInfo {
  return {
    id,
    title: `Approval ${id}`,
    projectId: null,
    operation: 'dispatch',
    reason: 'reason',
    impact: 'impact',
    command: null,
    status: 'pending',
    queuedAt: null,
    decidedAt: null,
    feedback: null,
    provenance: null,
    taskRef: null,
  };
}

const queue: ApprovalQueue = {
  entries: [approval('apr-1'), approval('apr-2')],
  approve: adapter.approve,
  reject: adapter.reject,
  isPending: false,
};

vi.mock('./useApprovalQueue', () => ({ useApprovalQueue: () => queue }));
vi.mock('@/design', () => ({ useToast: () => ({ toast: adapter.toast }) }));
vi.mock('@/i18n', () => ({
  useVocab: () => new Proxy({}, { get: (_target, key) => String(key) }),
}));

import { ApprovalCenterModal } from './ApprovalCenterModal';

beforeEach(() => {
  adapter.approve.mockReset().mockResolvedValue();
  adapter.reject.mockReset().mockResolvedValue();
  adapter.toast.mockReset();
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});

describe('ApprovalCenterModal', () => {
  it('keeps deny feedback and toast in the desktop surface while handing decisions to the queue', async () => {
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<ApprovalCenterModal open onClose={vi.fn()} />);
    });

    act(() => renderer!.root.findByProps({ 'data-action': 'arm' }).props.onClick());
    const field = renderer!.root.findByProps({ 'data-approval-feedback': '' });
    act(() => field.props.onChange({ target: { value: '  explain first  ' } }));

    await act(async () => {
      renderer!.root.findByProps({ 'data-action': 'reject' }).props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(adapter.reject).toHaveBeenCalledWith('apr-1', '  explain first  ');
    expect(adapter.toast).toHaveBeenCalledWith({ title: 'apToastRejected', tone: 'failed' });
    expect(renderer!.root.findAllByProps({ 'data-approval-feedback': '' })).toHaveLength(0);
  });

  it('clears desktop-only armed feedback when selection changes', async () => {
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<ApprovalCenterModal open onClose={vi.fn()} />);
    });
    act(() => renderer!.root.findByProps({ 'data-action': 'arm' }).props.onClick());
    act(() => {
      renderer!.root.findByProps({ 'data-approval-feedback': '' }).props.onChange({
        target: { value: 'draft' },
      });
      renderer!.root.findByProps({ 'data-approval-id': 'apr-2' }).props.onClick();
    });
    await act(async () => {});

    expect(renderer!.root.findByProps({ 'data-approval-center': '' }).props['data-approval-selected'])
      .toBe('apr-2');
    expect(renderer!.root.findAllByProps({ 'data-approval-feedback': '' })).toHaveLength(0);
  });
});
