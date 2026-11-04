import {
  barIndexAt, formatTick, hiddenMask, labelStride, roundedTopPath, stackLayout, tooltipRows,
  type ChartSeries,
} from '../stats-vm';
import { ChartFrame, TooltipBody, XLabels, YGrid, type ChartInsets } from './ChartFrame';

const INSETS: ChartInsets = { left: 44, right: 2, top: 8, bottom: 22 };
/** Room per x label, so dense ranges thin their labels instead of colliding. */
const LABEL_ROOM = 52;

/** Stacked columns, one per bucket: a 2px surface gap between segments, a rounded data end, and
 *  a per-column tooltip listing every visible series. */
export function StackedBarChart(props: {
  series: ChartSeries[];
  hidden: ReadonlySet<string>;
  labels: string[];
  titles: string[];
  height?: number;
  ariaLabel: string;
  totalLabel: string;
  format: (value: number) => string;
  dim?: boolean;
}) {
  const buckets = props.labels.length;
  const values = props.series.map((s) => s.values);
  const mask = hiddenMask(props.series, props.hidden);
  return (
    <ChartFrame height={props.height ?? 200} insets={INSETS} buckets={buckets} ariaLabel={props.ariaLabel} dim={props.dim}
      indexAt={barIndexAt}
      anchor={(index, frame) => {
        const column = stackLayout(values, mask, frame, buckets).columns[index];
        return column ? [column.x, column.x + column.width] : [0, 0];
      }}
      tooltip={(index) => {
        const rows = tooltipRows(props.series, props.hidden, index);
        return (
          <TooltipBody title={props.titles[index] ?? ''} rows={rows} format={props.format}
            total={{ label: props.totalLabel, value: rows.reduce((sum, row) => sum + row.value, 0) }} />
        );
      }}>
      {(frame, active) => {
        const layout = stackLayout(values, mask, frame, buckets);
        const plotWidth = frame.width - frame.left - frame.right;
        const stride = labelStride(buckets, Math.floor(plotWidth / LABEL_ROOM));
        return (
          <>
            {active !== null && layout.columns[active] ? (
              <rect className="stats-hover-slot" x={layout.columns[active].slotX} y={frame.top}
                width={layout.columns[active].slotWidth} height={frame.height - frame.top - frame.bottom} />
            ) : null}
            <YGrid frame={frame} ticks={layout.scale.ticks} y={layout.scale.y} format={(v) => formatTick(v, false)} />
            {layout.columns.map((column) => column.segments.map((segment) => (
              segment.top
                ? <path key={`${column.index}:${segment.series}`} data-bar-segment={props.series[segment.series].id}
                  d={roundedTopPath(segment.x, segment.y, segment.width, segment.height)} fill={props.series[segment.series].color} />
                : <rect key={`${column.index}:${segment.series}`} data-bar-segment={props.series[segment.series].id}
                  x={segment.x} y={segment.y} width={segment.width} height={segment.height} fill={props.series[segment.series].color} />
            )))}
            <XLabels frame={frame} labels={props.labels} stride={stride}
              x={(index) => (layout.columns[index] ? layout.columns[index].x + layout.columns[index].width / 2 : 0)} />
          </>
        );
      }}
    </ChartFrame>
  );
}
