// input:  React renderer, MemoryRouter, project view + usage screen (usage hook and view stubbed)
// output: Project-header Usage key regression tests
// pos:    Guard the Usage key beside the gear and its back target
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { act, create } from 'react-test-renderer';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { NOTES_COPY } from '@/features/notes/notes-copy';
import { LangProvider } from '@/i18n';
import { buildMNotesVm } from './m-notes-vm';
import { MProjectView, type MProjectCopy } from './MProjectView';

const usageView = vi.hoisted(() => ({ onBack: null as null | (() => void) }));
vi.mock('@/features/usage', () => ({ useUsage: () => ({}) }));
vi.mock('./MUsageView', () => ({
  MUsageView: (props: { onBack: () => void }) => {
    usageView.onBack = props.onBack;
    return null;
  },
}));
const { MUsageScreen } = await import('./MUsageScreen');

const noop = () => {};

describe('mobile Usage entry', () => {
  it('puts a Usage key directly before the settings gear', () => {
    const onUsage = vi.fn();
    const tree = create(<MProjectView
      copy={{ title: 'Project', usage: 'Usage', settings: 'Settings' } as MProjectCopy}
      current={null} pendingApprovals={0} globalPendingApprovals={0} issues={{ count: 0, previews: [] }}
      notesVm={buildMNotesVm([], Date.now(), 'en')} notesCopy={NOTES_COPY.en} notesBusy={false}
      switchRows={[]} rateLimitStatus={null} onOpenRateLimit={noop} onIssues={noop} onNotes={noop}
      onAddNote={async () => undefined} onApprovals={noop} onMemory={noop} onUsage={onUsage}
      onSettings={noop} onSwitch={noop} onNewProject={noop} />);
    const labels = tree.root.findAll((node) => node.type === 'button' && node.props['aria-label'])
      .map((node) => node.props['aria-label']);
    expect(labels.indexOf('Usage')).toBe(labels.indexOf('Settings') - 1);
    act(() => tree.root.findByProps({ 'aria-label': 'Usage' }).props.onClick());
    expect(onUsage).toHaveBeenCalledOnce();
    tree.unmount();
  });

  it.each([
    [{ from: 'project' }, '/m/project'],
    [null, '/m/settings'],
  ])('backs out of Usage to where it was opened from (%j)', (state, expected) => {
    let path = '';
    function Where() {
      path = useLocation().pathname;
      return null;
    }
    const tree = create(
      <LangProvider>
        <MemoryRouter initialEntries={[{ pathname: '/m/settings/usage', state }]}>
          <Routes>
            <Route path="/m/settings/usage" element={<MUsageScreen />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </LangProvider>,
    );
    act(() => usageView.onBack?.());
    expect(path).toBe(expected);
    tree.unmount();
  });
});
