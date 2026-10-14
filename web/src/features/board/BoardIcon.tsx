/** The board pennant: the chat header button, the live strip and the phone's board key. */
export function BoardIcon({ size = 13, stroke = 'currentColor', strokeWidth = 1.6 }: {
  size?: number;
  stroke?: string;
  strokeWidth?: number;
}): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke={stroke} strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
      <path d="M3.7 1.9v10.2" />
      <path d="M3.7 2.7h6.8L9.1 5l1.4 2.3H3.7z" />
    </svg>
  );
}
