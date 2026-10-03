import { clockTime, dayLabel, type TimeLang } from '@/lib/time-format';

/**
 * Day-divider label for the mobile chat stream (scheme L2946 "今天 07:42"): Today / Yesterday for
 * the current & previous calendar day, else the date — in the UI language, suffixed with local HH:MM.
 */
export function mobileDivider(lang: TimeLang): (ts: string, now: Date) => string {
  return (ts, now) => `${dayLabel(ts, now, lang)} ${clockTime(ts)}`;
}
