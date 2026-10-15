import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@radix-ui/react-dialog', () => {
  const part = (name: string) => ({ children, onOpenChange: _onOpenChange, ...props }: any) => (
    <div data-radix-part={name} {...props}>{children}</div>
  );
  return Object.fromEntries(['Root', 'Portal', 'Overlay', 'Content', 'Title', 'Description', 'Close', 'Trigger']
    .map((name) => [name, part(name)]));
});

import { DialogHost } from './DialogHost';
import { confirmDialog, currentDialog, dismissDialog, promptDialog } from './dialog-store';

let renderer: ReactTestRenderer;

afterEach(() => {
  while (dismissDialog());
  act(() => renderer?.unmount());
});

function mount(): void {
  act(() => { renderer = create(<DialogHost />); });
}

const find = (attr: string) => renderer.root.findByProps({ [attr]: '' });
const submit = () => renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} });

describe('app dialogs', () => {
  it('renders a confirm in the app chrome and resolves with the answer', async () => {
    mount();
    let answer: Promise<boolean>;
    act(() => { answer = confirmDialog({ title: 'Delete?', description: 'Gone for good.', confirmLabel: 'Delete', tone: 'danger' }); });
    const content = renderer.root.findByProps({ 'data-radix-part': 'Content' });
    expect(content.props['data-app-dialog']).toBe('confirm');
    expect(JSON.stringify(renderer.toJSON())).toContain('Gone for good.');
    expect(find('data-dialog-confirm').props.variant).toBe('danger');
    expect(content.props.onEscapeKeyDown).toEqual(expect.any(Function));
    expect(content.props.onCloseAutoFocus).toEqual(expect.any(Function));
    await act(async () => submit());
    await expect(answer!).resolves.toBe(true);
    expect(currentDialog()).toBeUndefined();
  });

  it('treats cancel and dismissal as a no', async () => {
    mount();
    let first: Promise<boolean>;
    let second: Promise<boolean>;
    act(() => {
      first = confirmDialog({ title: 'One', confirmLabel: 'OK' });
      second = confirmDialog({ title: 'Two', confirmLabel: 'OK' });
    });
    await act(async () => find('data-dialog-cancel').props.onClick());
    await expect(first!).resolves.toBe(false);
    expect(currentDialog()?.title).toBe('Two');
    await act(async () => { dismissDialog(); });
    await expect(second!).resolves.toBe(false);
  });

  it('returns trimmed prompt text and blocks an empty submit', async () => {
    mount();
    let answer: Promise<string | null>;
    act(() => { answer = promptDialog({ title: 'Add', inputLabel: 'Name', confirmLabel: 'Add' }); });
    expect(find('data-dialog-confirm').props.disabled).toBe(true);
    act(() => find('data-dialog-input').props.onChange({ target: { value: '  atlas ' } }));
    expect(find('data-dialog-confirm').props.disabled).toBe(false);
    await act(async () => submit());
    await expect(answer!).resolves.toBe('atlas');
  });
});
