/** The board pennant: the rail row marker, the chat header button and the dock tab chip. */
export function BoardIcon({ size = 13, stroke = 'currentColor' }: { size?: number; stroke?: string }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke={stroke} strokeWidth={1.6}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
      <path d="M3.7 1.9v10.2" />
      <path d="M3.7 2.7h6.8L9.1 5l1.4 2.3H3.7z" />
    </svg>
  );
}
