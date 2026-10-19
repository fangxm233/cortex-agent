import type { ReactNode } from 'react';

// Empty-state primitive: a centered title, optional description and optional action, set straight
// on the pane. No card: an empty state is nothing to act on, so it gets no box (v2).

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
        'flex flex-col items-center justify-center gap-1g p-6g text-center',
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
