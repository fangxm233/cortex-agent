import type { ButtonHTMLAttributes } from 'react';
import { MENU_FOCUS } from './MenuChrome';

// The borderless square icon control shared by the top bar, the rail and the chat header. Hover is
// CSS, so a row of these costs no state. `tone` picks the engaged (`active`) look: `neutral` for
// a standing toggle such as the rail switch, `accent` for an open panel or menu; `amber` is the
// always-lit attention badge.

export type IconButtonTone = 'neutral' | 'accent' | 'amber';

const QUIET = 'text-proto-muted enabled:hover:bg-proto-line-2 enabled:hover:text-proto-ink';

const TONE_CLASS: Record<IconButtonTone, { rest: string; active: string }> = {
  neutral: { rest: QUIET, active: 'bg-proto-line-2 text-proto-ink' },
  accent: { rest: QUIET, active: 'bg-proto-accent-bg text-proto-accent' },
  amber: { rest: 'bg-proto-amber-bg text-proto-amber-fg', active: 'bg-proto-amber-bg text-proto-amber-fg' },
};

const BASE = 'relative grid flex-none cursor-pointer place-items-center border-0 p-0 disabled:cursor-default disabled:text-proto-line-3';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name, and the tooltip unless `title` says more. */
  label: string;
  /** Box side in px. Small boxes get a tighter corner so they do not read as circles. */
  size?: number;
  tone?: IconButtonTone;
  active?: boolean;
}

export function IconButton({
  label, size = 30, tone = 'neutral', active = false, title, className, style, type = 'button', ...rest
}: IconButtonProps): JSX.Element {
  const toneClass = TONE_CLASS[tone][active ? 'active' : 'rest'];
  return (
    <button
      type={type}
      aria-label={label}
      title={title ?? label}
      className={[BASE, MENU_FOCUS, toneClass, className].filter(Boolean).join(' ')}
      style={{ width: size, height: size, borderRadius: size < 28 ? 6 : 'var(--r-chip)', ...style }}
      {...rest}
    />
  );
}
