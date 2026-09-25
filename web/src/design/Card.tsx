// input:  React, semantic material and opaque surface tokens
// output: Card, CardHeader, CardBody, CardProps
// pos:    Unblurred glass cards with an explicit reading surface
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import type { ReactNode } from 'react';

// Repeated cards composite without backdrop-filter. Use opaque for reading/occlusion, not to
// control blur; both variants are unfiltered and keep the same border, radius and padding.
const MATERIAL_CLASS = {
  glass: '[background:var(--material-card-bg)] shadow-[shadow:var(--material-card-shadow)]',
  opaque: 'bg-surface-card shadow-card',
};

export interface CardProps {
  children: ReactNode;
  className?: string;
  padded?: boolean;
  variant?: 'glass' | 'opaque';
}

export function Card({ children, className, padded, variant = 'glass' }: CardProps) {
  return (
    <div
      className={[
        'rounded-[var(--r-card)] border border-card',
        MATERIAL_CLASS[variant],
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
