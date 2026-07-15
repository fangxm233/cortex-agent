// Neutral placeholder body shared by the mobile STUB screen slots. Reserves the OS status-bar
// gutter (env(safe-area-inset-top), matching the scheme mobile screens) and shows the screen title +
// a neutral "slot" note. Sibling threads replace each screen behind its own export (RB f528 pattern).
import { type ReactNode } from 'react';

export function StubScreen({
  screenId,
  title,
  children,
}: {
  screenId: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div
      data-screen-label={screenId}
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        paddingTop: 'env(safe-area-inset-top)',
        boxSizing: 'border-box',
        background: '#F2F2F7',
      }}
    >
      <div style={{ flex: 'none', padding: '6px 14px 10px', borderBottom: '1px solid #E7E9EE' }}>
        <span style={{ fontSize: 22, fontWeight: 700, color: '#191C22', letterSpacing: '-.02em' }}>
          {title}
        </span>
      </div>
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          padding: '0 24px',
          textAlign: 'center',
        }}
      >
        {children ?? (
          <span style={{ fontSize: 13, color: '#8A93A2' }}>Screen slot — filled by a later pass.</span>
        )}
      </div>
    </div>
  );
}
