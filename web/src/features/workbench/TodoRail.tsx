// input:  task-list snapshot, language, persisted expand state
// output: collapsed summary or full click-to-collapse task list
// pos:    Shared session task-list surface above chat composers
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import type { TodoSnapshot, TodoStatus } from '@cortex-agent/ui-contract';
import { todoRailViewModel, type TodoRowViewModel } from './todo-vm';

const MONO = "'IBM Plex Mono',monospace";
/** Bounded so a long list can never push the composer off screen; the list scrolls instead. */
const EXPANDED_MAX_HEIGHT = '40vh';

const COPY = {
  en: { label: 'Task list', empty: 'No active task' },
  zh: { label: '任务清单', empty: '暂无进行中的任务' },
} as const;

export type TodoRailLanguage = keyof typeof COPY;

function storageKey(sessionId: string): string {
  return `cortex.todoRailOpen.${sessionId}`;
}

/** Expanded state is per session and persisted, matching the left rail's SCHEDULED zone. Collapsed
 *  is the default: the rail exists to be glanceable, and auto-expanding would move the composer
 *  under the user's cursor mid-turn. */
function useExpanded(sessionId: string): [boolean, () => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try { setOpen(window.localStorage.getItem(storageKey(sessionId)) === '1'); }
    catch { setOpen(false); }
  }, [sessionId]);
  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      try { window.localStorage.setItem(storageKey(sessionId), next ? '1' : '0'); } catch { /* private mode */ }
      return next;
    });
  }, [sessionId]);
  return [open, toggle];
}

function StatusDot({ status, allDone }: { status: TodoStatus; allDone: boolean }): JSX.Element {
  const base = { width: 14, height: 14, borderRadius: '50%', flex: 'none' as const, boxSizing: 'border-box' as const };
  if (status === 'completed') {
    return (
      <span
        style={{
          ...base,
          background: 'var(--proto-success-bg)',
          color: 'var(--proto-success)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 8,
          fontWeight: 700,
        }}
      >
        ✓
      </span>
    );
  }
  if (status === 'in_progress') {
    return (
      <span
        style={{
          ...base,
          background: allDone ? 'var(--proto-success)' : 'var(--proto-accent)',
          boxShadow: `0 0 0 3px ${allDone ? 'var(--proto-success-bg)' : 'var(--proto-accent-bg)'}`,
          animation: 'cxpulse 1.6s ease-in-out infinite',
        }}
      />
    );
  }
  return <span style={{ ...base, border: '1.5px solid var(--proto-line-3)' }} />;
}

function TodoRow({ row }: { row: TodoRowViewModel }): JSX.Element {
  const done = row.status === 'completed';
  const active = row.status === 'in_progress';
  return (
    <div style={{ display: 'flex', gap: 9, alignItems: 'stretch' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <StatusDot status={row.status} allDone={false} />
        {row.hasTail && <span style={{ flex: 1, width: 1.5, background: 'var(--proto-line-2)', margin: '3px 0' }} />}
      </div>
      <span
        style={{
          fontSize: 12.5,
          lineHeight: '15px',
          paddingBottom: row.hasTail ? 9 : 0,
          fontWeight: active ? 600 : 400,
          color: done ? 'var(--proto-muted-2)' : active ? 'var(--proto-ink)' : 'var(--proto-muted)',
          textDecoration: done ? 'line-through' : undefined,
        }}
      >
        {row.text}
      </span>
    </div>
  );
}

export interface TodoRailProps {
  sessionId: string;
  todos: TodoSnapshot | null;
  lang: TodoRailLanguage;
}

/**
 * Renders nothing at all when there is no task list. That is deliberate: an empty bar would cost
 * every session permanent vertical space directly above the input for a feature most turns never
 * use.
 */
export function TodoRail({ sessionId, todos, lang }: TodoRailProps): JSX.Element | null {
  const [open, toggle] = useExpanded(sessionId);
  const vm = todoRailViewModel(todos);
  if (!vm) return null;
  const L = COPY[lang];
  const accent = vm.allDone ? 'var(--proto-success)' : 'var(--proto-accent)';
  const collapseOnKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggle();
  };

  return (
    <div
      data-todo-rail={open ? 'expanded' : 'collapsed'}
      onClick={open ? toggle : undefined}
      onKeyDown={open ? collapseOnKeyDown : undefined}
      role={open ? 'button' : undefined}
      tabIndex={open ? 0 : undefined}
      aria-expanded={open ? true : undefined}
      aria-label={open ? L.label : undefined}
      style={{
        border: '1px solid var(--proto-line)',
        borderRadius: 8,
        background: 'var(--proto-alt)',
        marginBottom: 8,
        overflow: 'hidden',
        cursor: open ? 'pointer' : undefined,
        animation: 'cxmsg .34s cubic-bezier(.22,1,.36,1) both',
      }}
    >
      {!open && (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={false}
          aria-label={L.label}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            minHeight: 29,
            padding: '0 10px',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            textAlign: 'left',
            font: 'inherit',
            color: 'inherit',
          }}
        >
          <StatusDot status={vm.allDone ? 'completed' : 'in_progress'} allDone={vm.allDone} />
          <span style={{ font: `600 10.5px ${MONO}`, color: accent, flex: 'none' }}>{vm.counts}</span>
          <span
            style={{
              fontSize: 12,
              color: vm.activeLabel ? 'var(--proto-muted-2)' : 'var(--proto-faint)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              minWidth: 0,
            }}
          >
            {vm.activeLabel ?? L.empty}
          </span>
          <span style={{ marginLeft: 'auto', flex: 'none', fontSize: 9, color: 'var(--proto-muted-2)' }}>
            ▸
          </span>
        </button>
      )}
      {open && (
        <div style={{ maxHeight: EXPANDED_MAX_HEIGHT, overflowY: 'auto', padding: '12px 12px 11px' }}>
          {vm.rows.map((row) => <TodoRow key={row.key} row={row} />)}
        </div>
      )}
    </div>
  );
}
