import type { ReactNode } from 'react';

// Surface card primitive (design §5): opaque card, 1px token border, `--r-card` radius,
// subtle token shadow. `padded` applies the standard 16px (2g) inset.
//
// The fill stays `--proto-card` (opaque) rather than `--glass-2`: a Card is content, and content
// cards are exactly what ends up repeating inside a scroller. `--glass-2` is reserved for raised
// surfaces that are known to sit still inside a pane, and `--proto-card` is the contract for a
// surface that has to occlude whatever is behind it.

export interface CardProps {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}

export function Card({ children, className, padded }: CardProps) {
  return (
    <div
      className={[
        'rounded-[var(--r-card)] border border-card bg-surface-card shadow-card',
        padded ? 'p-2g' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </div>
  );
}

export function CardHeader({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={['border-b border-card px-2g py-1.5g', className].filter(Boolean).join(' ')}
    >
      {children}
    </div>
  );
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={['p-2g', className].filter(Boolean).join(' ')}>{children}</div>;
}
