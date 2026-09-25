// input:  SettingsProvider, react-test-renderer, mocked SettingsModal
// output: Settings entry section regression tests
// pos:    Verify direct section entries and the default entry
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { SettingsProvider, useSettings } from './SettingsProvider';

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

describe('SettingsProvider', () => {
  it('opens straight into a requested section, and plain open returns to the first one', () => {
    const view = create(<SettingsProvider><Probe /></SettingsProvider>);
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
