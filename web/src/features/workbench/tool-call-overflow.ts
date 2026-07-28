// input:  row width, measured chip widths, overflow suffix width
// output: visible/hidden counts and compact overflow text
// pos:    Pure collapsed tool-call overflow layout
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

export interface ToolCallOverflowInput {
  availableWidth: number;
  chipWidths: number[];
  overflowWidth: number;
  gap: number;
}

export interface ToolCallOverflowLayout {
  visibleCount: number;
  hiddenCount: number;
}

function widthWithGaps(widths: number[], gap: number): number {
  if (widths.length === 0) return 0;
  return widths.reduce((total, width) => total + width, 0) + gap * (widths.length - 1);
}

export function toolCallOverflowLayout(input: ToolCallOverflowInput): ToolCallOverflowLayout {
  const { availableWidth, chipWidths, overflowWidth, gap } = input;
  if (widthWithGaps(chipWidths, gap) <= availableWidth) {
    return { visibleCount: chipWidths.length, hiddenCount: 0 };
  }
  let usedWidth = 0;
  let visibleCount = 0;
  for (const width of chipWidths) {
    const nextWidth = usedWidth + (visibleCount > 0 ? gap : 0) + width;
    if (nextWidth + gap + overflowWidth > availableWidth) break;
    usedWidth = nextWidth;
    visibleCount += 1;
  }
  return { visibleCount, hiddenCount: chipWidths.length - visibleCount };
}

export function toolCallOverflowText(hiddenCount: number): string | null {
  return hiddenCount > 0 ? `+${hiddenCount}` : null;
}
