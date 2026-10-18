import type { TodoStatus } from '@cortex-agent/ui-contract';
import { useVocabOptional } from '@/i18n';
import type { TodoRailViewModel, TodoRowViewModel } from './todo-vm';
import { ActivityChip, CHIP_COUNT, CHIP_TEXT } from './ActivityChip';

/** The status-dot language in a 14px slot: a check once done, the running dot (accent with a soft
 *  halo) on the current item, a hollow ring for what is still to come. */
function StatusDot({ status }: { status: TodoStatus }): JSX.Element {
  const slot = { width: 14, height: 14, flex: 'none' as const, display: 'inline-grid', placeItems: 'center' };
  if (status === 'completed') {
    return (
      <span style={{
        ...slot, borderRadius: '50%', background: 'var(--proto-success-bg)', color: 'var(--proto-success)',
        fontSize: 8, fontWeight: 700,
      }}>
        ✓
      </span>
    );
  }
  const dot = status === 'in_progress'
    ? { width: 8, height: 8, background: 'var(--proto-accent)', boxShadow: '0 0 0 3px var(--proto-accent-bg)' }
    : { width: 9, height: 9, border: '1.5px solid var(--proto-muted-3)' };
  return <span style={slot}><span style={{ ...dot, borderRadius: '50%', boxSizing: 'border-box' }} /></span>;
}

function TodoRow({ row }: { row: TodoRowViewModel }): JSX.Element {
  const done = row.status === 'completed';
  const active = row.status === 'in_progress';
  return (
    <div style={{ display: 'flex', gap: 9, alignItems: 'stretch' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <StatusDot status={row.status} />
        {row.hasTail && <span style={{ flex: 1, width: 1.5, background: 'var(--proto-line-2)', margin: '3px 0' }} />}
      </div>
      <span style={{
        fontSize: 12.5, lineHeight: '15px', paddingBottom: row.hasTail ? 9 : 0, fontWeight: active ? 600 : 400,
        color: active ? 'var(--proto-ink)' : 'var(--proto-muted)', minWidth: 0, overflowWrap: 'anywhere',
        textDecoration: done ? 'line-through' : undefined,
      }}>
        {row.text}
      </span>
    </div>
  );
}

/** The whole list, as the capsule opens it (a popover on desktop, a sheet on the phone). */
export function TodoList({ vm }: { vm: TodoRailViewModel }): JSX.Element {
  const L = useVocabOptional();
  return (
    <div data-todo-list="">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '0 0 10px' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)' }}>{L.todoLabel}</span>
        <span style={{ ...CHIP_COUNT, fontWeight: 400, fontSize: 12, color: 'var(--proto-muted)' }}>{vm.counts}</span>
      </div>
      {vm.rows.map((row) => <TodoRow key={row.key} row={row} />)}
    </div>
  );
}

/** A ring filling with the completed share; a check once all is done. The arc is the one coloured
 *  mark on the capsule — progress is what the accent is for; the count beside it stays plain ink. */
function ProgressRing({ progress, done }: { progress: number; done: boolean }): JSX.Element {
  const r = 5.5;
  const length = 2 * Math.PI * r;
  const color = done ? 'var(--proto-success)' : 'var(--proto-accent)';
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" style={{ flex: 'none' }}>
      <circle cx="7" cy="7" r={r} fill="none" stroke="var(--proto-line-3)" strokeWidth="2" />
      <circle cx="7" cy="7" r={r} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round"
        strokeDasharray={`${length * progress} ${length}`} transform="rotate(-90 7 7)" />
      {done && <path d="m4.6 7.1 1.6 1.6 3.2-3.3" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

/** Progress ring, position and what the agent is doing now — the only capsule that carries text. */
export function TodoChip({ vm, floating, expanded, onToggle }: {
  vm: TodoRailViewModel;
  floating?: boolean;
  expanded?: boolean;
  onToggle: () => void;
}): JSX.Element {
  const L = useVocabOptional();
  const text = vm.activeLabel ?? (vm.allDone ? null : L.todoEmpty);
  return (
    <ActivityChip data="todo" grow label={[L.todoLabel, vm.counts, text].filter(Boolean).join(' · ')}
      floating={floating} expanded={expanded} onClick={onToggle}>
      <ProgressRing progress={vm.progress} done={vm.allDone} />
      <span style={CHIP_COUNT}>{vm.counts}</span>
      {text && <span style={{ ...CHIP_TEXT, color: 'var(--proto-muted)' }}>{text}</span>}
    </ActivityChip>
  );
}
