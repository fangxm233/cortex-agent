import type { ReactNode } from 'react';
import { useLangOptional } from '@/i18n';
import { STARRED_LIST_COPY } from './starred-list-copy';

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
  const copy = STARRED_LIST_COPY[useLangOptional()];
  if (count === 0) return null;
  return (
    <section data-starred-project={projectId}>
      <button type="button" aria-label={copy.title} aria-expanded={expanded} onClick={onToggle}
        style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', border: 0,
          background: 'transparent', color: 'var(--proto-muted)', cursor: 'pointer',
          minHeight: mobile ? 44 : 28, padding: mobile ? '0 14px' : '0 10px 0 28px',
          fontFamily: 'inherit', fontSize: mobile ? 13 : 11.5 }}>
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span aria-hidden="true">☆</span>
        <span>{copy.title}</span><span style={{ marginLeft: 'auto' }}>{count}</span>
      </button>
      {expanded && children}
    </section>
  );
}
