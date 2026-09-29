import type { ReactNode } from 'react';

// Repeated cards composite without backdrop-filter.
const MATERIAL_CLASS = '[background:var(--material-card-bg)] shadow-[shadow:var(--material-card-shadow)]';

export interface CardProps {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}

export function Card({ children, className, padded }: CardProps) {
  return (
    <div
      className={[
        'rounded-[var(--r-card)] border border-card',
        MATERIAL_CLASS,
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
