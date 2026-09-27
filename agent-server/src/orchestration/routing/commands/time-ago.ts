import { t } from '../../../core/i18n.js';

/** Render an elapsed duration as a compact localized "Ns/m/h/d ago" label. */
export function formatTimeAgo(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return t('notice.ago.seconds', { n: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('notice.ago.minutes', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('notice.ago.hours', { n: hours });
  return t('notice.ago.days', { n: Math.floor(hours / 24) });
}
