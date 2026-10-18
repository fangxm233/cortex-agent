import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { useFitLevel } from './useFitLevel';

// `need` stands in for how many folds the row takes to fit: it overflows while the level is below it.
function Probe({ need, resetKey }: { need: number; resetKey: string }): JSX.Element {
  const { ref, level } = useFitLevel<HTMLDivElement>(3, (_el, current) => current < need, resetKey);
  return <div ref={ref} data-level={level} />;
}

function mount(need: number, resetKey = 'a'): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<Probe need={need} resetKey={resetKey} />, { createNodeMock: () => ({}) }); });
  return renderer;
}
const level = (r: ReactTestRenderer): number => r.root.findByType('div').props['data-level'];

describe('useFitLevel', () => {
  it('stays at full size when the row fits', () => {
    expect(level(mount(0))).toBe(0);
  });

  it('folds one step per layout pass until the row fits, never past the last level', () => {
    expect(level(mount(2))).toBe(2);
    expect(level(mount(9))).toBe(3);
  });

  it('folds further when the content grows, and starts over from full when the text changes', () => {
    const r = mount(1);
    expect(level(r)).toBe(1);
    act(() => r.update(<Probe need={2} resetKey="a" />));
    expect(level(r)).toBe(2);
    // Shorter text alone keeps the fold (the cheap side); a new key re-fits from the top.
    act(() => r.update(<Probe need={0} resetKey="a" />));
    expect(level(r)).toBe(2);
    act(() => r.update(<Probe need={0} resetKey="b" />));
    expect(level(r)).toBe(0);
  });

  it('does nothing without a mounted element', () => {
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<Probe need={3} resetKey="a" />); });
    expect(level(renderer)).toBe(0);
  });
});
