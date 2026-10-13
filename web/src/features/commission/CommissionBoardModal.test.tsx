import type { ReactNode } from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { en, fmt, LangProvider } from '@/i18n';
import type { CommissionInfo } from '@cortex-agent/ui-contract';
import { CommissionBoardModal } from './CommissionBoardModal';

vi.mock('@/design/Modal', () => ({ Modal: ({ children }: { children: ReactNode }) => <>{children}</> }));

const commission = { id: 'atlas/task', projectId: 'atlas', slug: 'task', title: 'Task', status: 'active' } as CommissionInfo;

describe('abandon confirmation', () => {
  it.each([0, 3, null])('warns that active sessions are not stopped (count %s)', (count) => {
    const close = vi.fn();
    const view = create(<LangProvider><CommissionBoardModal commission={commission} ledger={null} contract={null}
      decisions={[]} gates={[]} activeSessionCount={count} sessionLabel={(id) => id} pending={false}
      onOpenSession={vi.fn()} onClose={close} onDismiss={vi.fn()} /></LangProvider>);
    const abandon = () => view.root.findAll((node) => node.type === 'button' && node.children.includes(en.wbCommissionAbandon));
    act(() => abandon()[0].props.onClick());
    expect(JSON.stringify(view.toJSON())).toContain(count === null
      ? en.wbCommissionWorkContinues : fmt(en.wbCommissionActiveContinues, { n: count }));
    expect(close).not.toHaveBeenCalled();
    act(() => abandon()[1].props.onClick());
    expect(close).toHaveBeenCalledWith('abandoned', '');
    act(() => view.unmount());
  });
});
