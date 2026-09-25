// input:  ApprovalCenterModal, mocked approval queue
// output: Approval presentation and queue handoff tests
// pos:    Approval center interaction regression coverage
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

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
  it('keeps approval selection keyboard reachable with one boundary', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(<ApprovalCenterModal open onClose={vi.fn()} />); });
    const selected = renderer.root.findByProps({ 'data-approval-id': 'apr-1' });
    expect(selected.props.tabIndex).toBe(0);
    expect(selected.props['aria-pressed']).toBe(true);
    expect(selected.props.style.boxShadow).toBe('var(--material-card-shadow)');
    expect(selected.props.style.backdropFilter).toBeUndefined();
    const click = vi.fn();
    const preventDefault = vi.fn();
    act(() => selected.props.onKeyDown({ key: ' ', preventDefault, currentTarget: { click } }));
    expect(click).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
    const close = renderer.root.findByProps({ 'aria-label': 'Close' });
    expect(close.type).toBe('button');
    act(() => renderer.unmount());
  });

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
    expect(renderer!.root.findAllByProps({ 'data-approval-feedback': '' })).toHaveLength(0);
  });
});
