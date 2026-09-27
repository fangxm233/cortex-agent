import type { ScheduleInfo } from '@cortex-agent/ui-contract';
import { humanizeDelta } from '@/features/schedule/schedule-modal-vm';
import type { TimeLang } from '@/lib/time-format';

const DAY_SHORT: Record<TimeLang, string[]> = {
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  zh: ['日', '一', '二', '三', '四', '五', '六'],
};

const CADENCE: Record<TimeLang, Record<ScheduleInfo['type'], string>> = {
  en: { daily: 'daily', weekly: 'weekly', interval: 'interval', once: 'once' },
  zh: { daily: '每天', weekly: '每周', interval: '间隔', once: '单次' },
};

/** Human cadence from the persisted timing spec — "daily 07:30" / "weekly Mon 10:00" /
 *  "every 30m" / "once" · "每天 07:30" / "每周一 10:00" / "每30分钟" / "单次". A legacy record
 *  without timing fields degrades to the bare type. */
export function cadenceLabel(s: ScheduleInfo, lang: TimeLang): string {
  const bare = CADENCE[lang][s.type] ?? s.type;
  if (s.type === 'daily') return s.time ? `${bare} ${s.time}` : bare;
  if (s.type === 'weekly') {
    const day = s.dayOfWeek != null ? DAY_SHORT[lang][s.dayOfWeek] : null;
    if (!day || !s.time) return bare;
    return lang === 'zh' ? `${bare}${day} ${s.time}` : `${bare} ${day} ${s.time}`;
  }
  if (s.type === 'interval' && s.intervalMs != null && s.intervalMs > 0) {
    const every = humanizeDelta(s.intervalMs, lang);
    return lang === 'zh' ? `每${every}` : `every ${every}`;
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
