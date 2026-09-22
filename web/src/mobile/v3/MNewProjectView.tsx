// input:  React, mobile kit, presentation props
// output: MNewProjectView
// pos:    Mobile NewProjectView presentation
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import type { ReactNode } from 'react';
import { MBottomSheet, MC, MONO } from '@/mobile/ui/kit';
import { canCreateProject } from '@/features/projects/new-project';

export interface MNewProjectCopy {
  title: string;
  tag: string;
  placeholder: string;
  create: string;
}

export function MNewProjectView({
  name,
  onNameChange,
  onCreate,
  onClose,
  copy,
  error,
  pending,
  behind,
}: {
  name: string;
  onNameChange: (v: string) => void;
  onCreate: () => void;
  onClose: () => void;
  copy: MNewProjectCopy;
  error: string | null;
  pending: boolean;
  behind?: ReactNode;
}) {
  const creatable = canCreateProject(name);
  const submittable = creatable && !pending;
  return (
    <MBottomSheet onClose={onClose} behind={behind}>
      {/* title row (L511) */}
      <div style={{ display: 'flex', alignItems: 'baseline', padding: '0 2px 12px' }}>
        <span style={{ fontSize: 17, fontWeight: 700, color: MC.ink, letterSpacing: '-.01em' }}>
          {copy.title}
        </span>
        <span style={{ marginLeft: 'auto', font: `400 11px ${MONO}`, color: MC.muted }}>
          {copy.tag}
        </span>
      </div>

      {/* name input (L512-515) — controlled, replaces the scheme's static placeholder + cursor */}
      <input
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && submittable) onCreate();
        }}
        placeholder={copy.placeholder}
        autoFocus
        style={{
          width: '100%',
          height: 48,
          border: '1.5px solid var(--proto-line-3)',
          borderRadius: 'var(--r-card)',
          background: 'var(--proto-card)',
          padding: '0 14px',
          fontSize: 16,
          fontFamily: 'inherit',
          color: MC.ink,
          boxSizing: 'border-box',
        }}
      />

      {error && (
        <div
          data-project-create-error={true}
          style={{ marginTop: 8, fontSize: 11, lineHeight: 1.5, color: 'var(--proto-danger)' }}
        >
          {error}
        </div>
      )}

      {/* create-and-chat button (L517) */}
      <button
        type="button"
        onClick={onCreate}
        disabled={!submittable}
        aria-busy={pending}
        style={{
          width: '100%',
          height: 48,
          border: 'none',
          borderRadius: 'var(--r-card)',
          background: MC.inkSolid,
          boxShadow: submittable ? 'var(--accent-glow)' : undefined,
          color: 'var(--ink-solid-fg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 14,
          fontWeight: 600,
          marginTop: 12,
          opacity: submittable ? 1 : 0.45,
          cursor: submittable ? 'pointer' : 'default',
        }}
      >
        {copy.create}
      </button>
    </MBottomSheet>
  );
}
