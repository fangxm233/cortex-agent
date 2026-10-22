import type { ReactNode } from 'react';
import type { CustomProviderApi } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';
import { MC, MSelect } from '@/mobile/ui/kit';
import { MSettingsSheet as MBottomSheet } from './MSettingsControls';
import {
  CUSTOM_PROVIDER_API_OPTIONS,
  customProviderFieldErrorCopy,
  isCustomProviderFormValid,
  type CustomProviderFormErrors,
  type CustomProviderFormState,
} from '@/features/settings/vm/custom-provider-vm';

const CONTROL_STYLE = {
  width: '100%', border: '1px solid var(--proto-line-3)', borderRadius: 8,
  background: 'var(--material-inset-bg)', padding: '11px 14px', fontSize: 16,
  fontFamily: 'inherit', color: MC.ink, boxSizing: 'border-box' as const, minHeight: 44,
};

interface ProviderSheetProps {
  draft: CustomProviderFormState;
  creating: boolean;
  errors: CustomProviderFormErrors;
  pending: boolean;
  onChange: (next: CustomProviderFormState) => void;
  onSave: () => void;
  onClose: () => void;
}

type ProviderFieldsProps = Pick<ProviderSheetProps, 'draft' | 'creating' | 'errors'> & {
  set: (patch: Partial<CustomProviderFormState>) => void;
};

function Field({ label, hint, danger, children }: {
  label: string; hint?: ReactNode; danger?: boolean; children: ReactNode;
}) {
  return <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
    <span style={{ fontSize: 13, fontWeight: 600, color: MC.muted }}>{label}</span>
    {children}
    {hint ? <span style={{ fontSize: 12, color: danger ? MC.fail : MC.muted }}>{hint}</span> : null}
  </label>;
}

function IdentityFields({ draft, creating, errors, set }: ProviderFieldsProps) {
  const L = useVocab();
  const nameHint = customProviderFieldErrorCopy(errors.name, L) ?? (creating ? L.cpvNameHint : L.cpvNoRename);
  return <>
    <Field label={L.cpvFieldName} hint={nameHint} danger={!!errors.name}>
      <input data-cpv-field="name" value={draft.name} disabled={!creating}
        onChange={e => set({ name: e.target.value })} style={{ ...CONTROL_STYLE, opacity: creating ? 1 : 0.55 }} />
    </Field>
    <Field label={L.cpvFieldApi}>
      <MSelect style={CONTROL_STYLE} title={L.cpvFieldApi} data-cpv-field="api" value={draft.api}
        onValueChange={api => set({ api: api as CustomProviderApi })}
        sheetClassName="settings-surface mobile-settings mobile-settings-sheet"
        options={CUSTOM_PROVIDER_API_OPTIONS.map(api => ({ value: api, label: api }))} />
    </Field>
  </>;
}

function ConnectionFields({ draft, errors, set }: ProviderFieldsProps) {
  const L = useVocab();
  return <>
    <Field label={L.cpvFieldUrl} hint={customProviderFieldErrorCopy(errors.upstreamUrl, L)} danger={!!errors.upstreamUrl}>
      <input data-cpv-field="url" value={draft.upstreamUrl}
        onChange={e => set({ upstreamUrl: e.target.value })} style={CONTROL_STYLE} />
    </Field>
    <Field label={L.cpvFieldKey} hint={L.cpvKeyHint}>
      <input data-cpv-field="key" type="password" value={draft.apiKey} placeholder={L.cpvKeyPlaceholder}
        onChange={e => set({ apiKey: e.target.value })} style={CONTROL_STYLE} />
    </Field>
    <Field label={L.cpvFieldModels} hint={customProviderFieldErrorCopy(errors.models, L) ?? L.cpvModelsHint} danger={!!errors.models}>
      <textarea data-cpv-field="models" value={draft.models} rows={3}
        onChange={e => set({ models: e.target.value })} style={{ ...CONTROL_STYLE, resize: 'vertical' }} />
    </Field>
  </>;
}

function SaveButton({ savable, onSave }: { savable: boolean; onSave: () => void }) {
  const L = useVocab();
  return <button type="button" data-cpv-action="save" onClick={onSave} disabled={!savable}
    style={{ width: '100%', minHeight: 44, border: 'none', borderRadius: 'var(--r-control)',
      background: 'var(--ink-solid-bg)', color: 'var(--ink-solid-fg)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 600,
      marginTop: 2, opacity: savable ? 1 : 0.45, cursor: savable ? 'pointer' : 'default' }}>
    {L.cpvSave}
  </button>;
}

export function MCustomProviderSheet(props: ProviderSheetProps) {
  const L = useVocab();
  const set = (patch: Partial<CustomProviderFormState>) => props.onChange({ ...props.draft, ...patch });
  return <MBottomSheet onClose={props.onClose}>
    <div style={{ display: 'flex', alignItems: 'baseline', padding: '0 2px 12px' }}>
      <span style={{ fontSize: 16, fontWeight: 650, color: MC.ink, letterSpacing: '-.01em' }}>
        {props.creating ? L.cpvCreateTitle : L.cpvEditTitle}
      </span>
    </div>
    <IdentityFields {...props} set={set} />
    <ConnectionFields {...props} set={set} />
    <SaveButton savable={isCustomProviderFormValid(props.errors) && !props.pending} onSave={props.onSave} />
  </MBottomSheet>;
}
