import { useLayoutEffect, type RefObject } from 'react';

/** Width a chat table is laid out at until it outgrows its cap. `fitTable` writes it back when it
 *  resets a table, so the render style and the reset can never disagree. */
export const TABLE_AUTO_WIDTH = 'max-content';

/** Added to a column kept whole, so sub-pixel rounding cannot push its last character onto a
 *  second line. */
const SLACK_PX = 1;

/** Split `budget` between columns by water-filling: every column whose one-line width fits under
 *  the current level (what is left ÷ columns still open) keeps that width, which raises the level
 *  for the rest; the columns that never fit share what remains evenly. Short columns therefore
 *  never wrap, and the long ones wrap first — where the browser's own algorithm shrinks every
 *  column by the same fraction, splitting a two-character label to make room for a paragraph. */
export function fitColumns(natural: number[], budget: number): number[] {
  const widths = natural.map((width) => Math.ceil(width) + SLACK_PX);
  let open = widths.map((_, index) => index);
  let left = budget;
  for (;;) {
    const level = left / open.length;
    const whole = open.filter((index) => widths[index] <= level);
    if (whole.length === 0) break;
    for (const index of whole) left -= widths[index];
    open = open.filter((index) => widths[index] > level);
    if (open.length === 0) return widths;
  }
  for (const index of open) widths[index] = left / open.length;
  return widths;
}

/** The row with the most cells: on a one-line table its cells span every column at full width. */
function widestRow(table: HTMLTableElement): HTMLTableCellElement[] {
  let widest: HTMLTableRowElement | undefined;
  for (const row of Array.from(table.rows)) {
    if (!widest || row.cells.length > widest.cells.length) widest = row;
  }
  return widest ? Array.from(widest.cells) : [];
}

function resetLayout(table: HTMLTableElement, cols: HTMLTableColElement[]): void {
  table.style.tableLayout = '';
  table.style.width = TABLE_AUTO_WIDTH;
  for (const col of cols) col.style.width = '';
}

/** Lays a too-wide table out with `fitColumns`. In auto layout the table already settles at
 *  `min(one-line width, cap)`, which is the budget; forcing every cell onto one line for a moment
 *  then reads each column's one-line width. Both reads happen before paint. A table that fits is
 *  left in auto layout, exactly as the browser drew it. */
export function fitTable(table: HTMLTableElement): void {
  const cols = Array.from(table.querySelectorAll('col'));
  resetLayout(table, cols);
  const budget = table.offsetWidth;
  table.style.whiteSpace = 'nowrap';
  const natural = widestRow(table).map((cell) => cell.offsetWidth);
  table.style.whiteSpace = '';
  if (natural.reduce((total, width) => total + width, 0) <= budget + SLACK_PX) return;
  fitColumns(natural, budget).forEach((width, index) => {
    if (cols[index]) cols[index].style.width = `${width}px`;
  });
  table.style.tableLayout = 'fixed';
  table.style.width = `${budget}px`;
}

/** Calls `callback` when `el` changes width; height changes (the table re-wrapping) are ignored. */
function onWidthChange(el: HTMLElement, callback: () => void): () => void {
  if (typeof ResizeObserver === 'undefined') return () => undefined;
  let width = el.clientWidth;
  const observer = new ResizeObserver(() => {
    if (el.clientWidth === width) return;
    width = el.clientWidth;
    callback();
  });
  observer.observe(el);
  return () => observer.disconnect();
}

/** Keeps a chat table's columns fitted: on mount and content change (`contentKey`), when its box
 *  changes width (the cap can be a percentage of it), and once web fonts have loaded. */
export function useFitTableColumns(
  wrapperRef: RefObject<HTMLElement>,
  tableRef: RefObject<HTMLTableElement>,
  contentKey: string,
): void {
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const table = tableRef.current;
    if (!wrapper || !table) return;
    const refit = (): void => fitTable(table);
    refit();
    let live = true;
    void document.fonts?.ready.then(() => { if (live) refit(); });
    const stopWatching = onWidthChange(wrapper, refit);
    return () => {
      live = false;
      stopWatching();
    };
  }, [wrapperRef, tableRef, contentKey]);
}
