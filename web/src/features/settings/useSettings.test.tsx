import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { ModalRegistryProvider } from '@/design/modal-registry';
import { SettingsModalHost, useSettings } from './useSettings';

vi.mock('./SettingsModal', () => ({
  SettingsModal: ({ open, initialSection }: { open: boolean; initialSection: string }) => (
    open ? <div data-modal-section={initialSection} /> : null
  ),
}));

let settings: ReturnType<typeof useSettings>;
function Probe() {
  settings = useSettings();
  return null;
}

function openedSection(view: ReturnType<typeof create>): string | undefined {
  return view.root.findAll((node) => node.props['data-modal-section'] !== undefined)[0]?.props['data-modal-section'];
}

describe('useSettings', () => {
  it('opens straight into a requested section, and plain open returns to the first one', () => {
    let view!: ReturnType<typeof create>;
    // Mounted inside act so the host's store subscription is live before the first open.
    act(() => { view = create(<ModalRegistryProvider><Probe /><SettingsModalHost /></ModalRegistryProvider>); });
    expect(openedSection(view)).toBeUndefined();

    act(() => settings.openSection('usage'));
    expect(openedSection(view)).toBe('usage');

    act(() => settings.close());
    expect(openedSection(view)).toBeUndefined();

    // Menu and gear callers hand `open` a click event; it must not be read as a section.
    act(() => (settings.open as (event: unknown) => void)({ type: 'click' }));
    expect(openedSection(view)).toBe('appearance');
    act(() => view.unmount());
  });
});
