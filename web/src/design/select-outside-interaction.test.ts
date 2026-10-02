import { describe, expect, it, vi } from 'vitest';
import { markSelectOutsideInteraction, preventSelectOutsideInteraction } from './select-outside-interaction';

function outsideEvent(originalEvent = new Event('pointerdown', { cancelable: true })) {
  return { detail: { originalEvent }, preventDefault: vi.fn() };
}

describe('Select outside interaction', () => {
  it('does not prevent an unmarked outside gesture', () => {
    const outside = outsideEvent();
    preventSelectOutsideInteraction(outside);
    expect(outside.preventDefault).not.toHaveBeenCalled();
  });

  it('marks only the original event without canceling Select or native defaults', () => {
    const selectOutside = outsideEvent();
    markSelectOutsideInteraction(selectOutside);
    expect(selectOutside.preventDefault).not.toHaveBeenCalled();
    expect(selectOutside.detail.originalEvent.defaultPrevented).toBe(false);

    const dialogOutside = outsideEvent(selectOutside.detail.originalEvent);
    preventSelectOutsideInteraction(dialogOutside);
    expect(dialogOutside.preventDefault).toHaveBeenCalledOnce();
    expect(selectOutside.detail.originalEvent.defaultPrevented).toBe(false);
  });

  it('keeps the original identity marked through delayed and repeated handling', () => {
    vi.useFakeTimers();
    try {
      const selectOutside = outsideEvent();
      markSelectOutsideInteraction(selectOutside);
      vi.advanceTimersByTime(60_000);
      const dialogOutside = outsideEvent(selectOutside.detail.originalEvent);
      preventSelectOutsideInteraction(dialogOutside);
      expect(dialogOutside.preventDefault).toHaveBeenCalledOnce();
      const repeatedOutside = outsideEvent(selectOutside.detail.originalEvent);
      preventSelectOutsideInteraction(repeatedOutside);
      expect(repeatedOutside.preventDefault).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows the next independent pointerdown even immediately after marking', () => {
    const selectOutside = outsideEvent();
    markSelectOutsideInteraction(selectOutside);
    const independentOutside = outsideEvent();
    preventSelectOutsideInteraction(independentOutside);
    expect(independentOutside.preventDefault).not.toHaveBeenCalled();
    const originalOutside = outsideEvent(selectOutside.detail.originalEvent);
    preventSelectOutsideInteraction(originalOutside);
    expect(originalOutside.preventDefault).toHaveBeenCalledOnce();
  });
});
