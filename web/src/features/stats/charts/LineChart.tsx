import {
  formatTick, hiddenMask, labelStride, lineIndexAt, lineLayout, lineX, tooltipRows, type ChartSeries,
} from '../stats-vm';
import { ChartFrame, TooltipBody, XLabels, YGrid, type ChartInsets } from './ChartFrame';

const INSETS: ChartInsets = { left: 36, right: 6, top: 8, bottom: 22 };
const LABEL_ROOM = 64;

/** One 2px line per series over integer counts, with a crosshair that snaps to the nearest bucket
 *  and a tooltip listing every visible series there. */
export function LineChart(props: {
  series: ChartSeries[];
  hidden: ReadonlySet<string>;
  labels: string[];
  titles: string[];
  height?: number;
  ariaLabel: string;
  format: (value: number) => string;
  dim?: boolean;
}) {
  const buckets = props.labels.length;
  const values = props.series.map((s) => s.values);
  const mask = hiddenMask(props.series, props.hidden);
  return (
    <ChartFrame height={props.height ?? 180} insets={INSETS} buckets={buckets} ariaLabel={props.ariaLabel} dim={props.dim}
      indexAt={lineIndexAt}
      anchor={(index, frame) => {
        const x = lineX(index, frame, buckets);
        return [x - 4, x + 4];
      }}
      tooltip={(index) => (
        <TooltipBody title={props.titles[index] ?? ''} rows={tooltipRows(props.series, props.hidden, index, true)} format={props.format} />
      )}>
      {(frame, active) => {
        const layout = lineLayout(values, mask, frame, buckets);
        const plotWidth = frame.width - frame.left - frame.right;
        const stride = labelStride(buckets, Math.floor(plotWidth / LABEL_ROOM));
        return (
          <>
            <YGrid frame={frame} ticks={layout.scale.ticks} y={layout.scale.y} format={(v) => formatTick(v, true)} />
            <XLabels frame={frame} labels={props.labels} stride={stride} x={(index) => layout.xs[index] ?? 0} edgeAnchor />
            {active !== null ? (
              <line className="stats-crosshair" x1={layout.xs[active]} x2={layout.xs[active]}
                y1={frame.top} y2={frame.height - frame.bottom} />
            ) : null}
            {layout.lines.map((line) => (
              <polyline key={props.series[line.series].id} data-line-series={props.series[line.series].id}
                points={line.points} fill="none" stroke={props.series[line.series].color}
                strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {active !== null ? layout.lines.map((line) => {
              const value = values[line.series][active] ?? 0;
              return (
                <circle key={props.series[line.series].id} cx={layout.xs[active]} cy={layout.scale.y(value)} r={4}
                  fill={props.series[line.series].color} stroke="var(--proto-card)" strokeWidth={2} />
              );
            }) : null}
          </>
        );
      }}
    </ChartFrame>
  );
}
