import { useCallback, useState, type CSSProperties } from 'react';
import type { TodoSnapshot } from '@cortex-agent/ui-contract';
import { MENU_SURFACE, useDismissMenu } from '@/design/MenuChrome';
import { pickVocab } from '@/i18n';
import { useFitLevel } from '@/lib/useFitLevel';
import type { SessionWaitpoints } from '@/features/session/live/useSessionWaitpoints';
import { todoStripViewModel } from './todo-vm';
import { waitRailViewModel, type WaitRailLanguage } from './wait-rail-vm';
import { TodoChip, TodoList } from './TodoChip';
import { WaitChip, WaitPanel } from './WaitChip';

// Desktop: the task list and the waitpoints share one line above the composer, each a capsule. A
// capsule opens its detail as a popover rising over the transcript, so the composer never moves.
// On a narrow pane the task keeps its label: the wait capsule yields width first, and once any
// label would truncate it folds to "waiting on <label>", its numbers moving to tooltip and popover.

type Open = 'todo' | 'wait' | null;

/** A capsule's text is cut off (its scroll width exceeds its box). */
function stripTruncates(strip: HTMLDivElement): boolean {
  return Array.from(strip.querySelectorAll<HTMLElement>('[data-activity-chip] span'))
    .some((span) => span.scrollWidth > span.clientWidth + 1);
}

const STRIP: CSSProperties = { position: 'relative', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, marginBottom: 8 };
const POPOVER: CSSProperties = {
  position: 'absolute', left: 0, bottom: 'calc(100% + 6px)', width: 'min(440px, 100%)', maxHeight: '50vh',
  overflowY: 'auto', overscrollBehavior: 'contain', boxSizing: 'border-box', padding: '12px 14px', zIndex: 30,
  border: '1px solid var(--proto-line)', borderRadius: 'var(--r-card)', animation: 'cxpopover .16s ease both',
  ...MENU_SURFACE,
};

/** What the turn is doing and what the session waits on, for a desktop chat. Nothing when neither. */
export function ActivityStrip({ todos, running, waitpoints, lang }: {
  todos: TodoSnapshot | null;
  running: boolean;
  waitpoints: SessionWaitpoints | null;
  lang: WaitRailLanguage;
}): JSX.Element | null {
  const [open, setOpen] = useState<Open>(null);
  const close = useCallback(() => setOpen(null), []);
  useDismissMenu(open !== null, close, close);
  const todo = todoStripViewModel(todos, running);
  const wait = waitpoints ? waitRailViewModel(waitpoints.waitpoints, Date.now(), pickVocab(lang), lang) : null;
  const { ref, level } = useFitLevel<HTMLDivElement>(1, stripTruncates, `${todo?.activeLabel ?? ''}\n${wait?.headline ?? ''}`);
  if (!todo && !wait) return null;
  const toggle = (which: Exclude<Open, null>) => () => setOpen((current) => (current === which ? null : which));
  return (
    <div ref={ref} data-activity-strip="" data-fit-level={level} style={STRIP}>
      {todo && <TodoChip vm={todo} expanded={open === 'todo'} onToggle={toggle('todo')} />}
      {wait && <WaitChip vm={wait} lang={lang} brief={level >= 1} expanded={open === 'wait'} onToggle={toggle('wait')} />}
      {open === 'todo' && todo && (
        <div data-activity-popover="todo" onClick={(event) => event.stopPropagation()} style={POPOVER}><TodoList vm={todo} /></div>
      )}
      {open === 'wait' && wait && waitpoints && (
        <div data-activity-popover="wait" onClick={(event) => event.stopPropagation()} style={POPOVER}>
          <WaitPanel vm={wait} lang={lang} onCancel={waitpoints.cancel} cancelling={waitpoints.cancelling} />
        </div>
      )}
    </div>
  );
}
