// input:  provider draft, validation, mobile Settings sheet
// output: MCustomProviderSheet
// pos:    Mobile custom provider sheet and inset inputs
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import type { ReactNode } from 'react';
import type { CustomProviderApi } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';
import { MC } from '@/mobile/ui/kit';
import { MSettingsSheet as MBottomSheet } from './MSettingsControls';
import {
  CUSTOM_PROVIDER_API_OPTIONS,
  customProviderFieldErrorCopy,
  isCustomProviderFormValid,
  type CustomProviderFormErrors,
  type CustomProviderFormState,
} from '@/features/settings/custom-provider-vm';

const CONTROL_STYLE = {
  width: '100%',
  border: '1px solid var(--proto-line-3)',
  borderRadius: 8,
  background: 'var(--material-inset-bg)',
  padding: '11px 14px',
  fontSize: 16,
  fontFamily: 'inherit',
  color: MC.ink,
  boxSizing: 'border-box' as const,
  minHeight: 44,
};

function Field({ label, hint, danger, children }: {
  label: string;
  hint?: ReactNode;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: MC.muted }}>{label}</span>
      {children}
      {hint ? (
        <span style={{ fontSize: 12, color: danger ? MC.fail : MC.muted }}>{hint}</span>
      ) : null}
    </label>
  );
}

export function MCustomProviderSheet({ draft, creating, errors, pending, onChange, onSave, onClose, behind }: {
  draft: CustomProviderFormState;
  creating: boolean;
  errors: CustomProviderFormErrors;
  pending: boolean;
  onChange: (next: CustomProviderFormState) => void;
  onSave: () => void;
  onClose: () => void;
  behind?: ReactNode;
}) {
  const L = useVocab();
  const set = (patch: Partial<CustomProviderFormState>) => onChange({ ...draft, ...patch });
  const hint = (field: keyof CustomProviderFormErrors, fallback: ReactNode) => {
    return customProviderFieldErrorCopy(errors[field], L) ?? fallback;
  };
  const savable = isCustomProviderFormValid(errors) && !pending;

  return (
    <MBottomSheet onClose={onClose} behind={behind}>
      <div style={{ display: 'flex', alignItems: 'baseline', padding: '0 2px 12px' }}>
        <span style={{ fontSize: 16, fontWeight: 650, color: MC.ink, letterSpacing: '-.01em' }}>
          {creating ? L.cpvCreateTitle : L.cpvEditTitle}
        </span>
      </div>

      <Field label={L.cpvFieldName} hint={hint('name', creating ? L.cpvNameHint : L.cpvNoRename)} danger={!!errors.name}>
        <input
          data-cpv-field="name" value={draft.name} disabled={!creating}
          onChange={(e) => set({ name: e.target.value })}
          style={{ ...CONTROL_STYLE, opacity: creating ? 1 : 0.55 }}
        />
      </Field>
      <Field label={L.cpvFieldApi} hint={L.cpvApiHint}>
        <select
          data-cpv-field="api" value={draft.api}
          onChange={(e) => set({ api: e.target.value as CustomProviderApi })}
          style={CONTROL_STYLE}
        >
          {CUSTOM_PROVIDER_API_OPTIONS.map((api) => <option key={api} value={api}>{api}</option>)}
        </select>
      </Field>
      <Field label={L.cpvFieldUrl} hint={hint('upstreamUrl', L.cpvUrlHint)} danger={!!errors.upstreamUrl}>
        <input
          data-cpv-field="url" value={draft.upstreamUrl}
          onChange={(e) => set({ upstreamUrl: e.target.value })}
          style={CONTROL_STYLE}
        />
      </Field>
      <Field label={L.cpvFieldKey} hint={L.cpvKeyHint}>
        <input
          data-cpv-field="key" type="password" value={draft.apiKey} placeholder={L.cpvKeyPlaceholder}
          onChange={(e) => set({ apiKey: e.target.value })}
          style={CONTROL_STYLE}
        />
      </Field>
      <Field label={L.cpvFieldModels} hint={hint('models', L.cpvModelsHint)} danger={!!errors.models}>
        <textarea
          data-cpv-field="models" value={draft.models} rows={3}
          onChange={(e) => set({ models: e.target.value })}
          style={{ ...CONTROL_STYLE, resize: 'vertical' }}
        />
      </Field>

      <button
        type="button" data-cpv-action="save" onClick={onSave} disabled={!savable}
        style={{
          width: '100%', minHeight: 44, border: 'none', borderRadius: 8,
          background: 'var(--proto-accent)',
          color: 'var(--ink-solid-fg)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 600,
          marginTop: 2, opacity: savable ? 1 : 0.45, cursor: savable ? 'pointer' : 'default',
        }}
      >
        {L.cpvSave}
      </button>
    </MBottomSheet>
  );
}
