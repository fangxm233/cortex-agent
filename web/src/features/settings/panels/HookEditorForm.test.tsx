import { useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { Combobox } from '@/design';
import { LangProvider } from '@/i18n';
import { emptyHookForm, type HookFormState } from '@/features/settings/vm/hooks-panel-vm';
import { HookEditor } from './HookEditorForm';

vi.mock('@/design/Select', async importOriginal => ({
  ...await importOriginal<typeof import('@/design/Select')>(), Select: (props: object) => <button {...props} />,
}));
vi.mock('@radix-ui/react-popover', () => {
  const part = ({ children }: any) => <>{children}</>;
  return { Root: part, Anchor: part, Portal: part, Content: part };
});

function Fixture({ draft = emptyHookForm(), change = vi.fn() }) {
  const [value, setValue] = useState(draft);
  return <LangProvider><HookEditor draft={value} creating errors={{}}
    scripts={[{ name: 'audit.py', usedBy: [], origin: 'local' }]}
    eventOptions={['cortex:session.new', 'agent:pre-tool']}
    onDraftChange={next => { setValue(next); change(next); }} /></LangProvider>;
}
function field(view: ReactTestRenderer, name: string) {
  return view.root.findAllByType('input').find(node => node.props['data-hook-field'] === name)!;
}
function type(view: ReactTestRenderer, name: string, value: string) {
  act(() => field(view, name).props.onChange({ target: { value } }));
}
function pick(view: ReactTestRenderer, name: string, value: string) {
  act(() => field(view, name).props.onFocus({}));
  const option = view.root.findAllByProps({ role: 'option' }).find(node => node.children.includes(value))!;
  act(() => option.props.onClick());
}

it('replaces datalists with named comboboxes while preserving hook field identifiers', () => {
  const view = create(<Fixture />);
  expect(view.root.findAllByType('datalist')).toHaveLength(0);
  expect(view.root.findAllByType(Combobox)).toHaveLength(2);
  for (const name of ['event', 'script']) {
    expect(field(view, name).props.role).toBe('combobox');
    expect(field(view, name).props['aria-label']).toBeTruthy();
    expect(field(view, name).props.list).toBeUndefined();
  }
});

it.each(['typed', 'picked'])('reconciles the result when an event is %s', mode => {
  const change = vi.fn();
  const draft: HookFormState = { ...emptyHookForm(), event: 'cortex:session.new', result: 'stdout-as-prompt' };
  const view = create(<Fixture draft={draft} change={change} />);
  if (mode === 'typed') type(view, 'event', 'custom:event');
  else pick(view, 'event', 'agent:pre-tool');
  expect(change).toHaveBeenLastCalledWith({ ...draft, event: mode === 'typed' ? 'custom:event' : 'agent:pre-tool', result: 'none' });
});

it('keeps a legal result when typing another compatible event', () => {
  const change = vi.fn();
  const draft: HookFormState = { ...emptyHookForm(), event: 'cortex:session.new', result: 'stdout-as-prompt' };
  const view = create(<Fixture draft={draft} change={change} />);
  type(view, 'event', 'cortex:session.messageEnd');
  expect(change).toHaveBeenLastCalledWith({ ...draft, event: 'cortex:session.messageEnd' });
});

it('accepts arbitrary script names and picks disk suggestions with the same draft callback', () => {
  const change = vi.fn(); const view = create(<Fixture change={change} />);
  type(view, 'script', 'custom-script.sh');
  expect(change).toHaveBeenLastCalledWith({ ...emptyHookForm(), script: 'custom-script.sh' });
  type(view, 'script', '');
  pick(view, 'script', 'audit.py');
  expect(change).toHaveBeenLastCalledWith({ ...emptyHookForm(), script: 'audit.py' });
  expect(field(view, 'script').props.value).toBe('audit.py');
});

it('leaves free-form shell commands as ordinary inputs', () => {
  const change = vi.fn(); const draft: HookFormState = { ...emptyHookForm(), runKind: 'command' };
  const view = create(<Fixture draft={draft} change={change} />);
  expect(field(view, 'command').props.role).toBeUndefined();
  type(view, 'command', 'echo test');
  expect(change).toHaveBeenLastCalledWith({ ...draft, command: 'echo test' });
});
