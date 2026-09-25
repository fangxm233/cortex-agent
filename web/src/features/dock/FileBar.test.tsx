// input:  FileBar, react-test-renderer, vitest
// output: Dock file action and metadata regression tests
// pos:    Verify keyboard controls retain file callbacks
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { FileBar, FileBarToggle } from './FileBar';

describe('dock file chrome', () => {
  it('keeps download and source actions as labeled native buttons', () => {
    const download = vi.fn();
    const toggle = vi.fn();
    const view = create(<FileBar path="project/docs/readme.md" onDownload={download}>
      <FileBarToggle on label="Rendered" title="Show rendered Markdown" onClick={toggle} />
    </FileBar>);
    const buttons = view.root.findAllByType('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0].props['aria-pressed']).toBe(true);
    expect(buttons[1].props['aria-label']).toBe('Download');
    act(() => buttons.forEach((button) => button.props.onClick()));
    expect(toggle).toHaveBeenCalledOnce();
    expect(download).toHaveBeenCalledOnce();
    const path = view.root.findByProps({ 'data-file-path': 'project/docs/readme.md' });
    expect(path.props.style.font).toContain('11px');
    expect(path.props.style.color).toBe('var(--proto-muted)');
    act(() => view.unmount());
  });
});
