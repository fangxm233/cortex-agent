import type { ScheduleInfo } from '@cortex-agent/ui-contract';
import { humanizeDelta } from '@/features/schedule/schedule-modal-vm';
import { fmt } from '@/i18n/fmt';
import { pickVocab } from '@/i18n/lang';
import type { TimeLang } from '@/i18n/time-format';

const DAY_SHORT = ['chatDaySun', 'chatDayMon', 'chatDayTue', 'chatDayWed', 'chatDayThu', 'chatDayFri', 'chatDaySat'] as const;

const CADENCE = {
  daily: 'chatCadenceDaily', weekly: 'chatCadenceWeekly', interval: 'chatCadenceInterval', once: 'chatCadenceOnce',
} as const satisfies Record<ScheduleInfo['type'], string>;

/** Human cadence from the persisted timing spec — "daily 07:30" / "weekly Mon 10:00" /
 *  "every 30m" / "once" · "每天 07:30" / "每周一 10:00" / "每30分钟" / "单次". A legacy record
 *  without timing fields degrades to the bare type. */
export function cadenceLabel(s: ScheduleInfo, lang: TimeLang): string {
  const L = pickVocab(lang);
  const key = CADENCE[s.type] as (typeof CADENCE)[keyof typeof CADENCE] | undefined;
  const bare = key ? L[key] : s.type;
  if (s.type === 'daily') return s.time ? `${bare} ${s.time}` : bare;
  if (s.type === 'weekly') {
    const dayKey = s.dayOfWeek != null ? DAY_SHORT[s.dayOfWeek] : undefined;
    const day = dayKey ? L[dayKey] : null;
    if (!day || !s.time) return bare;
    return fmt(L.chatCadenceWeeklyAt, { cadence: bare, day, time: s.time });
  }
  if (s.type === 'interval' && s.intervalMs != null && s.intervalMs > 0) {
    const every = humanizeDelta(s.intervalMs, lang);
    return fmt(L.chatCadenceEvery, { span: every });
  }
  return bare;
}

/** Delta until the next fire ("19h" / "30m" · "19小时"), or null when there is none (paused / legacy). */
export function nextRunDelta(nextRun: string | null, now: number, lang: TimeLang): string | null {
  if (!nextRun) return null;
  const ms = Date.parse(nextRun);
  if (Number.isNaN(ms)) return null;
  return humanizeDelta(ms - now, lang);
}
