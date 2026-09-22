// input:  React, monospaced font and ink tokens
// output: MonoText, MonoTextProps
// pos:    Monospaced data labels with opaque muted text
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import type { ElementType, ReactNode } from 'react';

// Monospace text primitive (IBM Plex Mono via `font-mono` token). Used for data
// values, IDs, counts — anything that should read as machine data (design §5).

export interface MonoTextProps {
  children: ReactNode;
  className?: string;
  muted?: boolean;
  as?: ElementType;
}

export function MonoText({ children, className, muted, as: Tag = 'span' }: MonoTextProps) {
  return (
    <Tag
      className={['font-mono text-ui', muted ? 'text-proto-muted' : '', className]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </Tag>
  );
}
