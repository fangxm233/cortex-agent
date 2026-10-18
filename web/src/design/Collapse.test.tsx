import { afterEach, describe, expect, it } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Collapse, useEntryAnimation } from './Collapse';

let mounted: ReactTestRenderer;
afterEach(() => act(() => mounted?.unmount()));

function Row({ id }: { id: string }): JSX.Element {
  const animation = useEntryAnimation('cxrise .2s');
  return <div data-row={id} data-animation={animation ?? 'none'} />;
}

const rows = (): Record<string, string> =>
  Object.fromEntries(mounted.root.findAll((n) => n.type === 'div' && n.props['data-row']).map((n) => [n.props['data-row'], n.props['data-animation']]));

const view = (open: boolean, ids: string[]): JSX.Element => <Collapse open={open}>{ids.map((id) => <Row key={id} id={id} />)}</Collapse>;

describe('Collapse', () => {
  it('opens and closes in one step without a DOM to animate', () => {
    act(() => { mounted = create(view(false, ['a'])); });
    expect(rows()).toEqual({});
    act(() => mounted.update(view(true, ['a'])));
    expect(Object.keys(rows())).toEqual(['a']);
    act(() => mounted.update(view(false, ['a'])));
    expect(rows()).toEqual({});
  });

  it('keeps entry animations off the rows it opens with, and on rows that arrive later', () => {
    act(() => { mounted = create(view(false, ['a'])); });
    act(() => mounted.update(view(true, ['a'])));
    act(() => mounted.update(view(true, ['a', 'b'])));
    expect(rows()).toEqual({ a: 'none', b: 'cxrise .2s' });
  });

  it('lets rows that mount already open animate like the rest of the stream', () => {
    act(() => { mounted = create(view(true, ['a'])); });
    expect(rows()).toEqual({ a: 'cxrise .2s' });
  });
});
