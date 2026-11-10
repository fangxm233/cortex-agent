import { useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { parsePatterns } from '@/features/settings/vm/models-panel-vm';

/** Input props for an edited pattern list, saved when the field loses focus or on Enter. A newly
 *  saved list replaces whatever is being typed. */
export function usePatternDraft(value: string[], onCommit: (patterns: string[]) => void) {
  const shown = value.join(', ');
  const [edit, setEdit] = useState({ shown, draft: shown });
  if (edit.shown !== shown) setEdit({ shown, draft: shown });
  const commit = () => {
    const next = parsePatterns(edit.draft);
    if (next.join(', ') !== shown) onCommit(next);
  };
  return {
    value: edit.shown === shown ? edit.draft : shown,
    onChange: (event: ChangeEvent<HTMLInputElement>) => setEdit({ shown, draft: event.target.value }),
    onBlur: commit,
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') commit(); },
  };
}
