import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { SwapText } from './SwapText';

interface FakeAnimation { onfinish: (() => void) | null; cancel: ReturnType<typeof vi.fn> }

let mounted: ReactTestRenderer;
const animations: FakeAnimation[] = [];

afterEach(() => {
  act(() => mounted?.unmount());
  animations.length = 0;
  vi.unstubAllGlobals();
});

function allowMotion(): void {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  vi.stubGlobal('document', { documentElement: { getAttribute: () => null } });
}

function mount(text: string): void {
  const createNodeMock = () => ({
    animate: () => {
      const animation: FakeAnimation = { onfinish: null, cancel: vi.fn() };
      animations.push(animation);
      return animation;
    },
  });
  act(() => { mounted = create(<SwapText text={text} />, { createNodeMock }); });
}

const lines = (): string[] => mounted.root.findAll((n) => n.type === 'span' && typeof n.children[0] === 'string')
  .map((n) => `${n.props['aria-hidden'] ? 'out' : 'in'}:${n.children[0]}`);

describe('SwapText', () => {
  it('swaps in one step without a DOM to animate', () => {
    mount('Ran 1 command');
    act(() => mounted.update(<SwapText text="Ran 2 commands" />));
    expect(lines()).toEqual(['in:Ran 2 commands']);
  });

  it('rolls the old words out under the new ones and drops them once the roll finishes', () => {
    allowMotion();
    mount('Ran 1 command');
    expect(animations).toHaveLength(0);
    act(() => mounted.update(<SwapText text="Ran 1 command · Thinking" />));
    expect(lines()).toEqual(['in:Ran 1 command · Thinking', 'out:Ran 1 command']);
    expect(animations).toHaveLength(2);
    act(() => animations[1].onfinish?.());
    expect(lines()).toEqual(['in:Ran 1 command · Thinking']);
  });

  it('cuts a roll short when the text changes again mid-way', () => {
    allowMotion();
    mount('A');
    act(() => mounted.update(<SwapText text="B" />));
    const [rise, fall] = animations;
    act(() => mounted.update(<SwapText text="C" />));
    expect(rise.cancel).toHaveBeenCalled();
    expect(fall.cancel).toHaveBeenCalled();
    expect(lines()).toEqual(['in:C', 'out:B']);
  });
});
