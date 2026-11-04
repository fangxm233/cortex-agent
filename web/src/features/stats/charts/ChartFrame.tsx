import { useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { ChartFrame as Frame, TooltipRow } from '../stats-vm';
import { useElementWidth } from './useElementWidth';

export type ChartInsets = Omit<Frame, 'width' | 'height'>;

// Tooltips open beside the hovered bucket and flip to its left near the right edge.
const TIP_OFFSET = 14;
const TIP_ROOM = 230;

function nextIndex(key: string, current: number | null, buckets: number): number | null | undefined {
  const last = buckets - 1;
  if (key === 'ArrowLeft') return current === null ? last : Math.max(0, current - 1);
  if (key === 'ArrowRight') return current === null ? last : Math.min(last, current + 1);
  if (key === 'Home') return 0;
  if (key === 'End') return last;
  if (key === 'Escape') return null;
  return undefined;
}

/** The interactive frame shared by the bar and line charts: measures its width, maps the pointer
 *  (or the arrow keys) to a bucket, and places the tooltip beside that bucket. */
export function ChartFrame(props: {
  height: number;
  insets: ChartInsets;
  buckets: number;
  ariaLabel: string;
  dim?: boolean;
  indexAt: (x: number, frame: Frame, buckets: number) => number | null;
  anchorX: (index: number, frame: Frame) => number;
  tooltip: (index: number) => ReactNode;
  children: (frame: Frame, active: number | null) => ReactNode;
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>(640);
  const [active, setActive] = useState<number | null>(null);
  const frame: Frame = { width, height: props.height, ...props.insets };
  const shown = active !== null && active < props.buckets ? active : null;
  const track = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    setActive(props.indexAt(event.clientX - box.left, frame, props.buckets));
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = nextIndex(event.key, shown, props.buckets);
    if (next === undefined || props.buckets === 0) return;
    event.preventDefault();
    setActive(next);
  };
  const anchor = shown === null ? 0 : props.anchorX(shown, frame);
  const flip = anchor + TIP_OFFSET + TIP_ROOM > width;
  return (
    <div ref={ref} className={props.dim ? 'stats-chart stats-dim' : 'stats-chart'} tabIndex={0}
      role="group" aria-label={props.ariaLabel} onKeyDown={onKey} onBlur={() => setActive(null)}>
      <svg width={width} height={props.height} aria-hidden="true"
        onPointerMove={track} onPointerDown={track} onPointerLeave={() => setActive(null)}>
        {props.children(frame, shown)}
      </svg>
      {shown !== null ? (
        <div className="stats-tip" data-stats-tip={shown} role="status"
          style={flip ? { right: Math.max(0, width - anchor + TIP_OFFSET) } : { left: anchor + TIP_OFFSET }}>
          {props.tooltip(shown)}
        </div>
      ) : null}
    </div>
  );
}

/** Tooltip body: the bucket, then one row per series — value first, name after — and an
 *  optional total. */
export function TooltipBody(props: {
  title: string;
  rows: TooltipRow[];
  format: (value: number) => string;
  total?: { label: string; value: number };
}) {
  return (
    <>
      <div className="stats-tip-title">{props.title}</div>
      {props.rows.map((row) => (
        <div key={row.id} className="stats-tip-row">
          <i style={{ background: row.color }} />
          <b>{props.format(row.value)}</b>
          <span>{row.name}</span>
        </div>
      ))}
      {props.total ? (
        <div className="stats-tip-row stats-tip-total">
          <i style={{ background: 'transparent' }} />
          <b>{props.format(props.total.value)}</b>
          <span>{props.total.label}</span>
        </div>
      ) : null}
    </>
  );
}

/** Horizontal gridlines with their tick labels; the baseline is one step stronger. */
export function YGrid(props: { frame: Frame; ticks: number[]; y: (v: number) => number; format: (v: number) => string }) {
  const { frame } = props;
  return (
    <g>
      {props.ticks.map((tick) => {
        const y = Math.round(props.y(tick)) + 0.5;
        return (
          <g key={tick}>
            <line className="stats-grid-line" data-base={tick === 0 ? '' : undefined}
              x1={frame.left} x2={frame.width - frame.right} y1={y} y2={y} />
            <text x={frame.left - 6} y={y + 3.5} textAnchor="end">{props.format(tick)}</text>
          </g>
        );
      })}
    </g>
  );
}

/** X labels under the plot, every `stride` buckets. */
export function XLabels(props: {
  frame: Frame;
  labels: string[];
  stride: number;
  x: (index: number) => number;
  edgeAnchor?: boolean;
}) {
  const y = props.frame.height - 6;
  return (
    <g>
      {props.labels.map((label, index) => {
        if (index % props.stride !== 0) return null;
        const anchor = props.edgeAnchor && index === 0 ? 'start' : 'middle';
        return <text key={index} x={props.x(index)} y={y} textAnchor={anchor}>{label}</text>;
      })}
    </g>
  );
}
