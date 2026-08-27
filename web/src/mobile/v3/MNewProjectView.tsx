// input:  controlled project name, shared create state, localized copy, and sheet actions
// output: mobile new-project bottom-sheet content with real backend errors
// pos:    Presentational project creation sheet
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
// @ds-adherence-ignore -- mobile v3 raw px/hex/font by design §8.3 (scheme-mobile.dc.html 1i L509-518)
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
        <span style={{ marginLeft: 'auto', font: `400 9.5px ${MONO}`, color: MC.faint }}>
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
          borderRadius: 13,
          background: 'var(--proto-card)',
          padding: '0 14px',
          font: `400 13.5px ${MONO}`,
          color: MC.ink,
          boxSizing: 'border-box',
          outline: 'none',
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
          borderRadius: 13,
          background: MC.ink,
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
