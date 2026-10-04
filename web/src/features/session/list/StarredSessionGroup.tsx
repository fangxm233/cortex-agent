import type { ReactNode } from 'react';
import { useVocabOptional } from '@/i18n';

interface Props {
  projectId: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  mobile?: boolean;
  children: ReactNode;
}

/** A project-local disclosure; empty (including filtered-out) groups have no chrome. */
export function StarredSessionGroup({ projectId, count, expanded, onToggle, mobile, children }: Props) {
  const L = useVocabOptional();
  if (count === 0) return null;
  return (
    <section data-starred-project={projectId}>
      <button type="button" aria-label={L.chatStars} aria-expanded={expanded} onClick={onToggle}
        style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', border: 0,
          background: 'transparent', color: 'var(--proto-muted)', cursor: 'pointer',
          minHeight: mobile ? 44 : 28, padding: mobile ? '0 14px' : '0 10px 0 28px',
          fontFamily: 'inherit', fontSize: mobile ? 13 : 11.5 }}>
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span aria-hidden="true">☆</span>
        <span>{L.chatStars}</span><span style={{ marginLeft: 'auto' }}>{count}</span>
      </button>
      {expanded && children}
    </section>
  );
}
