import type { ReactNode } from 'react';

// Empty-state primitive (design §5, design 10d): centered card with muted title,
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
      {icon && <div className="text-state-ink/40">{icon}</div>}
      <div className="text-body font-medium text-state-ink/70">{title}</div>
      {description && <p className="max-w-md text-ui text-state-ink/50">{description}</p>}
      {action && <div className="mt-1g">{action}</div>}
    </div>
  );
}
