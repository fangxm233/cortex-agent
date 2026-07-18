// @ds-adherence-ignore -- mobile v3 raw px/hex/font by design §8.3 (scheme-mobile.dc.html 1i L509-518)
// 1i 新建项目 — presentational bottom-sheet content. Pure: no data, no tRPC. The MBottomSheet kit
// renders the dimmed overlay + rounded sheet + drag handle; this View fills the sheet body: title
// row + faint projects/ tag · 48px controlled name input · hint · 48px ink create button.
import type { ReactNode } from 'react';
import { MBottomSheet, MC, MONO } from '@/mobile/ui/kit';
import { canCreate, type MNewProjectCopy } from './m-new-project-vm';

// The two literal, untranslated mono code fragments woven into the hint (scheme L516).
const NAME_CODE = 'projects/<name>/';
const INIT_CODE = 'project_init';

function Mono({ children }: { children: ReactNode }) {
  return <span style={{ fontFamily: MONO, fontSize: 10 }}>{children}</span>;
}

export function MNewProjectView({
  name,
  onNameChange,
  onCreate,
  onClose,
  copy,
  behind,
}: {
  name: string;
  onNameChange: (v: string) => void;
  onCreate: () => void;
  onClose: () => void;
  copy: MNewProjectCopy;
  behind?: ReactNode;
}) {
  const creatable = canCreate(name);
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
          if (e.key === 'Enter' && creatable) onCreate();
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

      {/* hint (L516) */}
      <div style={{ fontSize: 11, lineHeight: 1.6, color: MC.muted, padding: '10px 4px 0' }}>
        {copy.hintA}
        <Mono>{NAME_CODE}</Mono>
        {copy.hintB}
        <Mono>{INIT_CODE}</Mono>
        {copy.hintC}
      </div>

      {/* create-and-chat button (L517) */}
      <button
        type="button"
        onClick={onCreate}
        disabled={!creatable}
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
          opacity: creatable ? 1 : 0.45,
          cursor: creatable ? 'pointer' : 'default',
        }}
      >
        {copy.create}
      </button>
    </MBottomSheet>
  );
}
