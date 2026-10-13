import { useState } from 'react';
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { useMobileMessageEdit, type MobileMessageEdit } from './m-chat-edit';

it('keeps a failed mobile edit and restores the original draft only after success', async () => {
  const submit = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({});
  let edit!: MobileMessageEdit;
  let text = '';
  let changeText!: (value: string) => void;
  function Probe() {
    const [value, setText] = useState('Unsent draft');
    text = value;
    changeText = setText;
    edit = useMobileMessageEdit({
      rows: [{ kind: 'user', text: 'Original', turnIndex: 0 }], running: false,
      text: value, setText, rewind: { submit, pending: false }, onStart: vi.fn(),
    });
    return null;
  }
  const tree = create(<Probe />);
  act(() => edit.hold(0, null));
  act(() => edit.msgMenu?.onEdit?.());
  act(() => changeText('Revised'));
  await act(async () => edit.submit(text));
  expect(edit.armed).toBe(true);
  expect(text).toBe('Revised');
  await act(async () => edit.submit(text));
  expect(edit.armed).toBe(false);
  expect(text).toBe('Unsent draft');
  expect(submit).toHaveBeenNthCalledWith(2, 0, 'Revised');
  act(() => tree.unmount());
});
