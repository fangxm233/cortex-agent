import type { LegendItem } from '../stats-vm';

/** The chart's legend as a grid: colour bar, name, share and amount. Pressing an entry hides its
 *  series and the chart rescales to the rest. */
export function Legend({ items, onToggle }: { items: LegendItem[]; onToggle: (id: string) => void }) {
  return (
    <div className="stats-legend">
      {items.map((item) => (
        <button key={item.id} type="button" className="stats-legend-item" data-legend-item={item.id}
          aria-pressed={!item.hidden} title={item.name} onClick={() => onToggle(item.id)}>
          <i style={{ background: item.color }} />
          <span className="stats-legend-text">
            <span className="stats-legend-name">{item.name}</span>
            <span className="stats-legend-share">{item.share}<small>{item.value}</small></span>
          </span>
        </button>
      ))}
    </div>
  );
}
