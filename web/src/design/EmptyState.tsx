// input:  React, theme ink and surface tokens
// output: EmptyState, EmptyStateProps
// pos:    Readable empty-content title, guidance and actions
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import type { ReactNode } from 'react';

// Empty-state primitive: centered card with a clear title,
// optional description, optional action. Generalizes the shell EmptyPane.
// Opaque like `Card`, and for the same reason: it is content sitting in a pane, not a sheet
// floating over one.

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, icon, action, className }: EmptyStateProps) {
  return (
    <div
      className={[
        'flex flex-col items-center justify-center gap-1g rounded-[var(--r-card)] border border-card',
        'bg-surface-card p-6g text-center shadow-card',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {icon && <div className="text-proto-muted">{icon}</div>}
      <div className="text-body font-semibold leading-snug text-proto-ink">{title}</div>
      {description && <p className="max-w-md text-ui leading-relaxed text-proto-muted [overflow-wrap:anywhere]">{description}</p>}
      {action && <div className="mt-1g">{action}</div>}
    </div>
  );
}
