import { createContext, useContext, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const HostContext = createContext<HTMLElement | null>(null);

/** Above screen chrome, below app-update frames and the toaster. */
const hostStyle: CSSProperties = { position: 'absolute', inset: 0, zIndex: 20, pointerEvents: 'none' };

/**
 * Screens live inside the animated outlet's own stacking context, so nothing a screen renders can
 * rise above shell-level chrome. Overlays portal into this shell-level layer instead.
 */
export function MobileOverlayHost({ children }: { children: ReactNode }): JSX.Element {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <HostContext.Provider value={host}>
      {children}
      <div ref={setHost} data-mobile-overlay-host style={hostStyle} />
    </HostContext.Provider>
  );
}

/** Renders in place when no shell host exists (isolated tests, previews). */
export function MobileOverlayPortal({ children }: { children: ReactNode }): JSX.Element {
  const host = useContext(HostContext);
  return host ? createPortal(children, host) : <>{children}</>;
}
