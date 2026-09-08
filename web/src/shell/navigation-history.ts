// input:  the current route / project / session tuple and the existing stack
// output: push, replace and dedupe rules for the app navigation stack
// pos:    Pure state rules behind the top bar's back and forward buttons
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

/** One navigable location. Route alone is not enough: every session lives at `/workbench`, so
 *  switching session — the app's dominant navigation — never changes the path. The project is part
 *  of the tuple because `SelectedSessionProvider` re-derives the session per project. */
export interface NavEntry {
  route: string;
  projectId: string | null;
  sessionId: string | null;
}

export interface NavStack {
  entries: NavEntry[];
  index: number;
}

export function sameEntry(a: NavEntry | undefined, b: NavEntry | undefined): boolean {
  if (!a || !b) return false;
  return a.route === b.route && a.projectId === b.projectId && a.sessionId === b.sessionId;
}

/** True when `next` is `current` with its session merely resolved for the first time.
 *  `selectedSessionId` settles asynchronously (`resolveSelectedSessionId` falls back to the
 *  most-recent session only once `sessions.list` lands), so the first tuple of a launch — and of
 *  every project switch — arrives with a null session and is filled in a tick later. Treating that
 *  as a navigation would leave a dead entry the user can "go back" to. */
function isNullFill(current: NavEntry | undefined, next: NavEntry): boolean {
  if (!current) return false;
  return current.route === next.route
    && current.projectId === next.projectId
    && current.sessionId === null
    && next.sessionId !== null;
}

/** Fold a newly observed tuple into the stack. Pushing truncates any forward history, exactly like
 *  a browser: navigating after going back discards the entries you came from. */
export function recordEntry(stack: NavStack, next: NavEntry): NavStack {
  const current = stack.entries[stack.index];
  if (sameEntry(current, next)) return stack;
  if (isNullFill(current, next)) {
    const entries = stack.entries.slice();
    entries[stack.index] = next;
    return { entries, index: stack.index };
  }
  const entries = stack.entries.slice(0, stack.index + 1);
  entries.push(next);
  return { entries, index: entries.length - 1 };
}

export function canGoBack(stack: NavStack): boolean {
  return stack.index > 0;
}

export function canGoForward(stack: NavStack): boolean {
  return stack.index < stack.entries.length - 1;
}
