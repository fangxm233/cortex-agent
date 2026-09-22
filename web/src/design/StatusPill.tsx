// input:  Status tones, semantic color pairs and material sheen
// output: StatusPill, StatusPillProps
// pos:    Semantic status labels with restrained surface texture
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { statusTone, type Tone } from './tone';

// Token-driven status pill (design §5 pill palette). No hard-coded hex — the
// bg/fg pair is selected from the tailwind `pill-<tone>-{bg,fg}` tokens, and the
// radius is `--r-pill`, so the component finally is the shape its name claims.

const TONE_CLASS: Record<Tone, string> = {
  running: 'bg-pill-running-bg text-pill-running-fg',
  waiting: 'bg-pill-waiting-bg text-pill-waiting-fg',
  done: 'bg-pill-done-bg text-pill-done-fg',
  failed: 'bg-pill-failed-bg text-pill-failed-fg',
  cancelled: 'bg-pill-cancelled-bg text-pill-cancelled-fg',
};

const BASE =
  'inline-flex items-center rounded-[var(--r-pill)] px-1g py-0.5g font-mono text-ui leading-none ' +
  'bg-[image:var(--material-sheen)]';

export interface StatusPillProps {
  /** Explicit tone; takes precedence over `status`. */
  tone?: Tone;
  /** Contract status string (thread/task/execution); mapped via `statusTone`. */
  status?: string;
  /** Visible label; defaults to `status`. */
  label?: string;
  className?: string;
}

export function StatusPill({ tone, status, label, className }: StatusPillProps) {
  const resolved: Tone = tone ?? (status ? statusTone(status) : 'cancelled');
  const text = label ?? status ?? resolved;
  return (
    <span className={[BASE, TONE_CLASS[resolved], className].filter(Boolean).join(' ')}>
      {text}
    </span>
  );
}
