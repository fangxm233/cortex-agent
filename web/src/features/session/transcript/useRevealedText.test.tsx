import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useRevealedText } from './useRevealedText';

let frames: FrameRequestCallback[] = [];
let clock = 0;
let mounted: ReactTestRenderer;

function runFrames(n: number): void {
  for (let k = 0; k < n; k++) {
    const due = frames;
    frames = [];
    clock += 16;
    act(() => { for (const f of due) f(clock); });
  }
}

function Probe({ text, at }: { text: string; at: string }): JSX.Element {
  const shown = useRevealedText(text, true, 'session-a');
  return <span data-at={at}>{shown}</span>;
}

const shownText = (): string => String(mounted.root.findByType('span').children.join(''));

afterEach(() => {
  act(() => mounted?.unmount());
  vi.unstubAllGlobals();
  frames = [];
});

describe('useRevealedText', () => {
  it('carries the reveal over when the preview remounts in another place', () => {
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { frames.push(f); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const text = 'x'.repeat(300);
    act(() => { mounted = create(<Probe key="log" at="log" text={text} />); });
    runFrames(6);
    const before = shownText().length;
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(text.length);
    // The note grew into the reply: same text, new instance below the log.
    act(() => mounted.update(<Probe key="answer" at="answer" text={text} />));
    expect(shownText().length).toBeGreaterThanOrEqual(before);
  });
});
