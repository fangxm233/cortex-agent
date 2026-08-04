// input:  ScheduleInfo DTO, schedule-modal humanizeDelta
// output: cadenceLabel + nextRunDelta for the schedule context bar
// pos:    Pure VM for the 27b scheduled-session chat surface
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { ScheduleInfo } from '@cortex-agent/ui-contract';
import { humanizeDelta } from '@/features/schedule/schedule-modal-vm';

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Human cadence from the persisted timing spec — "daily 07:30" / "weekly Mon 10:00" /
 *  "every 30m" / "once". A legacy record without timing fields degrades to the bare type. */
export function cadenceLabel(s: ScheduleInfo): string {
  if (s.type === 'daily') return s.time ? `daily ${s.time}` : 'daily';
  if (s.type === 'weekly') {
    const day = s.dayOfWeek != null ? DAY_SHORT[s.dayOfWeek] : null;
    return day && s.time ? `weekly ${day} ${s.time}` : 'weekly';
  }
  if (s.type === 'interval') {
    return s.intervalMs != null && s.intervalMs > 0 ? `every ${humanizeDelta(s.intervalMs)}` : 'interval';
  }
  return 'once';
}

/** Delta until the next fire ("19h" / "30m"), or null when there is none (paused / legacy). */
export function nextRunDelta(nextRun: string | null, now: number): string | null {
  if (!nextRun) return null;
  const ms = Date.parse(nextRun);
  if (Number.isNaN(ms)) return null;
  return humanizeDelta(ms - now);
}
