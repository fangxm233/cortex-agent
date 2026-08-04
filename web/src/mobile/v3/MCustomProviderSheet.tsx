// @ds-adherence-ignore -- mobile v3 raw px/font by design §8.3
// input:  a custom provider draft and its validation errors
// output: bottom-sheet editor for one user-defined PI provider
// pos:    Presentational mobile custom provider editor
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { ReactNode } from 'react';
import type { CustomProviderApi } from '@cortex-agent/ui-contract';
import { useVocab, type Vocab } from '@/i18n';
import { MBottomSheet, MC, MONO } from '@/mobile/ui/kit';
import {
  CUSTOM_PROVIDER_API_OPTIONS,
  isCustomProviderFormValid,
  type CustomProviderFieldError,
  type CustomProviderFormErrors,
  type CustomProviderFormState,
} from '@/features/settings/custom-provider-vm';

const FIELD_ERROR_LABEL: Record<CustomProviderFieldError, keyof Vocab> = {
  'name-required': 'cpvErrNameRequired',
  'name-charset': 'cpvErrNameCharset',
  'name-taken': 'cpvErrNameTaken',
  'upstream-required': 'cpvErrUpstreamRequired',
  'upstream-scheme': 'cpvErrUpstreamScheme',
  'models-required': 'cpvErrModelsRequired',
  'model-id-duplicate': 'cpvErrModelsDuplicate',
};

const CONTROL_STYLE = {
  width: '100%',
  border: '1.5px solid var(--proto-line-3)',
  borderRadius: 13,
  background: 'var(--proto-card)',
  padding: '11px 14px',
  font: `400 13.5px ${MONO}`,
  color: MC.ink,
  boxSizing: 'border-box' as const,
  outline: 'none',
};

function Field({ label, hint, danger, children }: {
  label: string;
  hint?: ReactNode;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 11 }}>
      <span style={{ font: `600 10px ${MONO}`, color: MC.muted }}>{label}</span>
      {children}
      {hint ? (
        <span style={{ font: `400 9.5px ${MONO}`, color: danger ? MC.fail : MC.faint }}>{hint}</span>
      ) : null}
    </div>
  );
}

export function MCustomProviderSheet({ draft, creating, errors, onChange, onSave, onClose, behind }: {
  draft: CustomProviderFormState;
  creating: boolean;
  errors: CustomProviderFormErrors;
  onChange: (next: CustomProviderFormState) => void;
  onSave: () => void;
  onClose: () => void;
  behind?: ReactNode;
}) {
  const L = useVocab();
  const set = (patch: Partial<CustomProviderFormState>) => onChange({ ...draft, ...patch });
  const hint = (field: keyof CustomProviderFormErrors, fallback: ReactNode) => {
    const code = errors[field];
    return code ? L[FIELD_ERROR_LABEL[code]] : fallback;
  };
  const savable = isCustomProviderFormValid(errors);

  return (
    <MBottomSheet onClose={onClose} behind={behind}>
      <div style={{ display: 'flex', alignItems: 'baseline', padding: '0 2px 12px' }}>
        <span style={{ fontSize: 17, fontWeight: 700, color: MC.ink, letterSpacing: '-.01em' }}>
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
          width: '100%', height: 48, border: 'none', borderRadius: 13,
          background: MC.ink, color: 'var(--ink-solid-fg)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 600,
          marginTop: 2, opacity: savable ? 1 : 0.45, cursor: savable ? 'pointer' : 'default',
        }}
      >
        {L.cpvSave}
      </button>
    </MBottomSheet>
  );
}
