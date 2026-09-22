import type { ReactNode } from 'react';
import { MonoText } from './MonoText';

// Section header: title + optional mono count + right-aligned actions + optional
// description line. Used to head grouped lists and panes (design §5).

export interface SectionHeaderProps {
  title: ReactNode;
  count?: number;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function SectionHeader({
  title,
  count,
  description,
  actions,
  className,
}: SectionHeaderProps) {
  return (
    <div className={['flex flex-col gap-0.5g', className].filter(Boolean).join(' ')}>
      <div className="flex items-center gap-1g">
        <h2 className="text-body font-medium text-state-ink">{title}</h2>
        {count !== undefined && (
          <MonoText muted className="rounded-[var(--r-chip)] bg-surface-canvas-alt px-1g py-0.5g">
            {count}
          </MonoText>
        )}
        {actions && <div className="ml-auto flex items-center gap-1g">{actions}</div>}
      </div>
      {description && <p className="text-ui text-state-ink/60">{description}</p>}
    </div>
  );
}
