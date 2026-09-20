import { describe, expect, it } from 'vitest';
import { shouldPoll } from './useSessionWaitpoints';

describe('shouldPoll', () => {
  it('does not poll a session that is waiting on nothing', () => {
    expect(shouldPoll(0, 0)).toBe(false);
  });

  it('polls while waitpoints are on screen', () => {
    expect(shouldPoll(2, 0)).toBeTypeOf('number');
  });

  // The regression this function exists for: gating the poll on the fetched list alone means an
  // empty list can never become non-empty, because nothing would ever fetch again. `waitingOn`
  // rides on sessions.list, which every turn edge invalidates, so it is what breaks the deadlock.
  it('starts polling when the session reports a wait the list has not caught up with', () => {
    expect(shouldPoll(0, 1)).toBeTypeOf('number');
  });
});
