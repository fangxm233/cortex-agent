import type { CSSProperties, ReactNode } from 'react';
import { MSelect, Select } from '@/design';
import { S_CONTROL_STYLE } from '@/features/settings/ui/settings-ui';
import type { StatsQuery } from '@/features/stats';
import { useVocab } from '@/i18n';
import '@/features/stats/stats.css';

/** Desktop lays sections out as tables and side-by-side cards; mobile stacks them as lists. */
export type StatsVariant = 'desktop' | 'mobile';

export function StatsHeading({ title, meta, children }: { title: ReactNode; meta?: ReactNode; children?: ReactNode }) {
  return (
    <div className="stats-heading">
      <span className="stats-heading-title">{title}</span>
      {meta != null ? <span className="stats-heading-meta">{meta}</span> : null}
      {children != null ? <span className="stats-heading-right">{children}</span> : null}
    </div>
  );
}

export function StatsCard({ flush, dim, className, children, ...rest }: {
  flush?: boolean;
  dim?: boolean;
  className?: string;
  children: ReactNode;
} & Record<string, unknown>) {
  const classes = ['stats-card', flush ? 'stats-card--flush' : '', dim ? 'stats-dim' : '', className ?? ''].filter(Boolean).join(' ');
  return <div {...rest} className={classes}>{children}</div>;
}

export function StatsNote({ children, tone, ...rest }: { children: ReactNode; tone?: 'error' } & Record<string, unknown>) {
  return <div {...rest} className="stats-state" data-tone={tone}>{children}</div>;
}

/** A read's loading and error lines, else its content. A refetch keeps showing the last result. */
export function StatsQueryState<T>({ query, children }: { query: StatsQuery<T>; children: (data: T) => ReactNode }) {
  const L = useVocab();
  if (query.data !== undefined) return <>{children(query.data)}</>;
  if (query.error) return <StatsNote tone="error" data-stats-error>{L.statsLoadError}: {query.error.message}</StatsNote>;
  return <StatsNote data-stats-loading>{L.statsLoading}</StatsNote>;
}

export interface StatsSelectOption {
  value: string;
  label: string;
}

const DESKTOP_SELECT: CSSProperties = { ...S_CONTROL_STYLE, width: 'auto', minWidth: 120, maxWidth: 220, gap: 8 };
const MOBILE_SELECT: CSSProperties = { width: 'auto', minWidth: 0, maxWidth: '100%', minHeight: 36, padding: '4px 10px', fontSize: 14 };

/** A compact value picker: a popup menu on desktop, a bottom sheet on mobile. */
export function StatsSelect(props: {
  variant: StatsVariant;
  value: string;
  options: StatsSelectOption[];
  onChange: (value: string) => void;
  label: string;
  dataAttr?: string;
  style?: CSSProperties;
}) {
  const data = props.dataAttr ? { [props.dataAttr]: props.value } : {};
  if (props.variant === 'mobile') {
    return (
      <MSelect {...data} value={props.value} options={props.options} onValueChange={props.onChange} title={props.label}
        aria-label={props.label} sheetClassName="settings-surface mobile-settings mobile-settings-sheet" style={{ ...MOBILE_SELECT, ...props.style }} />
    );
  }
  return (
    <Select {...data} value={props.value} options={props.options} onValueChange={props.onChange} aria-label={props.label}
      density="bare" popupClassName="settings-surface settings-select-popup" style={{ ...DESKTOP_SELECT, ...props.style }} />
  );
}

export function ShowMore({ onClick, ...rest }: { onClick: () => void } & Record<string, unknown>) {
  const L = useVocab();
  return <button {...rest} type="button" className="stats-more" onClick={onClick}>{L.statsShowMore}</button>;
}

export function Chevron() {
  return (
    <svg className="stats-chevron" width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function Swatch({ color }: { color: string }) {
  return <span className="stats-swatch" style={{ background: color }} aria-hidden="true" />;
}

/** A label and an amount on one line, the label keyed by a colour swatch. */
export function KeyValue({ color, name, value }: { color?: string; name: ReactNode; value: ReactNode }) {
  return (
    <div className="stats-kv">
      <span>{color ? <Swatch color={color} /> : null}{name}</span>
      <span>{value}</span>
    </div>
  );
}

/** A large figure with its caption, e.g. "12.9B tokens · 84,078 requests". */
export function StatsFigure({ value, caption }: { value: ReactNode; caption?: ReactNode }) {
  return (
    <div className="stats-figure">
      <span className="stats-figure-value">{value}</span>
      {caption != null ? <span className="stats-figure-caption">{caption}</span> : null}
    </div>
  );
}
