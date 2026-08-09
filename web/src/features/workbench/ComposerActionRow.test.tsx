// input:  Composer controls, slash suggestions and callbacks
// output: Action-row and local slash-menu wiring regressions
// pos:    Desktop composer action-row layout specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { LangProvider } from '@/i18n';
import { ComposerActionRow, ComposerSlashMenu } from './ComposerActionRow';

describe('ComposerSlashMenu', () => {
  it('runs enabled UI suggestions and ignores disabled ones', () => {
    const onPick = vi.fn();
    const renderer = create(
      <LangProvider>
        <ComposerSlashMenu
          suggestions={[
            { command: '/new', description: 'new', action: { type: 'new' }, disabled: false },
            { command: '/cancel', description: 'cancel', action: { type: 'cancel' }, disabled: true },
          ]}
          onPick={onPick}
        />
      </LangProvider>,
    );

    act(() => renderer.root.findByProps({ 'data-slash-command': '/new' }).props.onClick());
    act(() => renderer.root.findByProps({ 'data-slash-command': '/cancel' }).props.onClick());

    expect(onPick).toHaveBeenCalledOnce();
    expect(onPick.mock.calls[0][0].command).toBe('/new');
  });
});

describe('ComposerActionRow', () => {
  it('keeps profile, attach and commands in one action row', () => {
    const onAttach = vi.fn();
    const onCommands = vi.fn();
    const renderer = create(
      <LangProvider>
        <ComposerActionRow
          profileControl={<span data-chip="profile">profile · plan</span>}
          hint="send hint"
          onAttach={onAttach}
          onCommands={onCommands}
        />
      </LangProvider>,
    );
    const row = renderer.root.findByProps({ 'data-composer-actions': true });
    const chips = ['profile', 'attach', 'commands'].map((chip) => (
      renderer.root.findByProps({ 'data-chip': chip })
    ));

    expect(chips.every((chip) => chip.parent === row)).toBe(true);
    act(() => chips[1].props.onClick());
    act(() => chips[2].props.onClick());
    expect(onAttach).toHaveBeenCalledOnce();
    expect(onCommands).toHaveBeenCalledOnce();
  });
});
