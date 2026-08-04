// input:  ScheduleInfo, schedules.pause/resume mutations, schedule modal
// output: 27b schedule context bar under the chat header
// pos:    Scheduled-session provenance + controls strip
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ScheduleInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { useScheduleModal } from '@/features/schedule/ScheduleModalProvider';
import { cadenceLabel, nextRunDelta } from './scheduled-chat';

const mono = "'IBM Plex Mono',monospace";

/** Context strip for a scheduled session's chat (design 27b header content, rendered as a bar under
 *  the standard ChatHeader so profile/session controls stay available): clock + schedule name +
 *  cadence chip + next-run/paused state + Pause/Resume + Edit schedule ↗. */
export function ScheduleContextBar({ schedule }: { schedule: ScheduleInfo }): JSX.Element {
  const L = useVocab();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const scheduleModal = useScheduleModal();
  const invalidate = () => queryClient.invalidateQueries(trpc.schedules.list.queryFilter());
  const pauseMut = useMutation(trpc.schedules.pause.mutationOptions({ onSettled: invalidate }));
  const resumeMut = useMutation(trpc.schedules.resume.mutationOptions({ onSettled: invalidate }));
  const busy = pauseMut.isPending || resumeMut.isPending;
  const delta = nextRunDelta(schedule.nextRun, Date.now());

  return (
    <div
      data-schedule-bar={schedule.id}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '7px 20px',
        borderBottom: '1px solid var(--proto-line)',
        background: 'var(--proto-rail)',
        flex: 'none',
        minWidth: 0,
      }}
    >
      <svg width={13} height={13} viewBox="0 0 14 14" fill="none" stroke="var(--proto-accent)" strokeWidth={1.6} style={{ flex: 'none' }}>
        <circle cx="7" cy="7" r="5.6" />
        <path d="M7 4v3.2l2.2 1.3" />
      </svg>
      <span
        style={{
          fontSize: 12.5,
          fontWeight: 600,
          color: 'var(--proto-ink)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          minWidth: 0,
        }}
      >
        {schedule.message}
      </span>
      <span
        style={{
          font: `500 10.5px ${mono}`,
          border: '1px solid var(--proto-line-2)',
          color: 'var(--proto-muted)',
          padding: '2px 7px',
          borderRadius: 6,
          flex: 'none',
        }}
      >
        {cadenceLabel(schedule)}
      </span>
      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12, flex: 'none' }}>
        {schedule.paused ? (
          <span style={{ font: `500 10px ${mono}`, color: 'var(--proto-amber)' }}>{L.wbSchedPausedPill}</span>
        ) : (
          delta && (
            <span style={{ font: `400 10px ${mono}`, color: 'var(--proto-muted-3)' }}>
              {L.wbSchedNextRun.replace('{d}', delta)}
            </span>
          )
        )}
        <span
          data-action={schedule.paused ? 'schedule-resume' : 'schedule-pause'}
          onClick={() => {
            if (busy) return;
            if (schedule.paused) resumeMut.mutate({ scheduleId: schedule.id });
            else pauseMut.mutate({ scheduleId: schedule.id });
          }}
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--proto-muted)',
            border: '1px solid var(--proto-line-2)',
            borderRadius: 7,
            padding: '3.5px 10px',
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.55 : 1,
          }}
        >
          {schedule.paused ? `▶ ${L.resume}` : `⏸ ${L.pause}`}
        </span>
        <span
          data-action="schedule-edit"
          onClick={() => scheduleModal.openEdit(schedule)}
          style={{ fontSize: 11, fontWeight: 600, color: 'var(--proto-accent)', cursor: 'pointer' }}
        >
          {L.wbEditSchedule}
        </span>
      </span>
    </div>
  );
}
