import type { ReactNode } from 'react';
import type { CustomProviderApi } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';
import { MC, MSelect } from '@/mobile/ui/kit';
import { MSettingsSheet as MBottomSheet } from './MSettingsControls';
import {
  CLAUDE_AUTH_STYLES,
  CONNECTION_KIND_VOCAB_KEYS,
  CUSTOM_PROVIDER_API_OPTIONS,
  connectionFieldErrorCopy,
  connectionFieldSpec,
  emptyConnectionForm,
  isConnectionFormValid,
  type ClaudeAuthStyle,
  type ConnectionFieldSpec,
  type ConnectionFormErrors,
  type ConnectionFormKind,
  type ConnectionFormState,
} from '@/features/settings/vm/connections-vm';

const CONTROL_STYLE = {
  width: '100%', border: '1px solid var(--proto-line-3)', borderRadius: 8,
  background: 'var(--material-inset-bg)', padding: '11px 14px', fontSize: 16,
  fontFamily: 'inherit', color: MC.ink, boxSizing: 'border-box' as const, minHeight: 44,
};
const SHEET_CLASS = 'settings-surface mobile-settings mobile-settings-sheet';

interface ConnectionSheetProps {
  draft: ConnectionFormState;
  creating: boolean;
  errors: ConnectionFormErrors;
  pending: boolean;
  kinds: ConnectionFormKind[];
  overridable: string[];
  onChange: (next: ConnectionFormState) => void;
  onSave: () => void;
  onClose: () => void;
}

type FieldsProps = ConnectionSheetProps & { spec: ConnectionFieldSpec; set: (patch: Partial<ConnectionFormState>) => void };

function Field({ label, hint, danger, children }: {
  label: string; hint?: ReactNode; danger?: boolean; children: ReactNode;
}) {
  return <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
    <span style={{ fontSize: 13, fontWeight: 600, color: MC.muted }}>{label}</span>
    {children}
    {hint ? <span style={{ fontSize: 12, color: danger ? MC.fail : MC.muted }}>{hint}</span> : null}
  </label>;
}

function KindField({ draft, kinds, set }: FieldsProps) {
  const L = useVocab();
  return <Field label={L.connFieldKind}>
    <MSelect style={CONTROL_STYLE} title={L.connFieldKind} data-conn-field="kind" value={draft.kind} sheetClassName={SHEET_CLASS}
      onValueChange={kind => set({ ...emptyConnectionForm(kind as ConnectionFormKind), key: draft.key, baseUrl: draft.baseUrl })}
      options={kinds.map(kind => ({ value: kind, label: L[CONNECTION_KIND_VOCAB_KEYS[kind]] }))} />
  </Field>;
}

function NameField({ draft, spec, errors, overridable, set }: FieldsProps) {
  const L = useVocab();
  const hint = connectionFieldErrorCopy(errors.name, L) ?? (spec.kindSelect ? L.connNameHint : L.connNoRename);
  return <Field label={L[spec.nameLabel]} hint={hint} danger={!!errors.name}>
    {spec.nameSelect
      ? <MSelect style={CONTROL_STYLE} title={L[spec.nameLabel]} data-conn-field="name" value={draft.name} sheetClassName={SHEET_CLASS}
          onValueChange={name => set({ name })} options={overridable.map(provider => ({ value: provider, label: provider }))} />
      : <input data-conn-field="name" value={draft.name} disabled={!spec.kindSelect}
          onChange={e => set({ name: e.target.value })} style={{ ...CONTROL_STYLE, opacity: spec.kindSelect ? 1 : 0.55 }} />}
  </Field>;
}

function ProtocolField({ draft, spec, set }: FieldsProps) {
  const L = useVocab();
  if (spec.api) {
    return <Field label={L.connFieldApi}>
      <MSelect style={CONTROL_STYLE} title={L.connFieldApi} data-conn-field="api" value={draft.api} sheetClassName={SHEET_CLASS}
        onValueChange={api => set({ api: api as CustomProviderApi })}
        options={CUSTOM_PROVIDER_API_OPTIONS.map(api => ({ value: api, label: api }))} />
    </Field>;
  }
  if (!spec.authStyle) return null;
  return <Field label={L.connFieldAuth}>
    <MSelect style={CONTROL_STYLE} title={L.connFieldAuth} data-conn-field="auth" value={draft.authStyle} sheetClassName={SHEET_CLASS}
      onValueChange={authStyle => set({ authStyle: authStyle as ClaudeAuthStyle })}
      options={CLAUDE_AUTH_STYLES.map(style => ({ value: style, label: style }))} />
  </Field>;
}

function EndpointFields({ draft, spec, errors, set }: FieldsProps) {
  const L = useVocab();
  const urlHint = connectionFieldErrorCopy(errors.baseUrl, L) ?? (spec.urlHint ? L[spec.urlHint] : undefined);
  const keyHint = connectionFieldErrorCopy(errors.key, L) ?? (spec.keyHint ? L[spec.keyHint] : undefined);
  return <>
    <Field label={L.connFieldUrl} hint={urlHint} danger={!!errors.baseUrl}>
      <input data-conn-field="url" value={draft.baseUrl} onChange={e => set({ baseUrl: e.target.value })} style={CONTROL_STYLE} />
    </Field>
    <Field label={L.connFieldKey} hint={keyHint} danger={!!errors.key}>
      <input data-conn-field="key" type="password" autoComplete="new-password" value={draft.key}
        placeholder={spec.kindSelect ? undefined : L.connKeyPlaceholder}
        onChange={e => set({ key: e.target.value })} style={CONTROL_STYLE} />
    </Field>
  </>;
}

function ModelsField({ draft, spec, errors, set }: FieldsProps) {
  const L = useVocab();
  if (!spec.models) return null;
  return <Field label={L.connFieldModels} hint={connectionFieldErrorCopy(errors.models, L) ?? L[spec.modelsHint]} danger={!!errors.models}>
    <textarea data-conn-field="models" value={draft.models} rows={3}
      onChange={e => set({ models: e.target.value })} style={{ ...CONTROL_STYLE, resize: 'vertical' }} />
  </Field>;
}

function SaveButton({ savable, onSave }: { savable: boolean; onSave: () => void }) {
  const L = useVocab();
  return <button type="button" data-conn-action="save" onClick={onSave} disabled={!savable}
    style={{ width: '100%', minHeight: 44, border: 'none', borderRadius: 'var(--r-control)',
      background: 'var(--ink-solid-bg)', color: 'var(--ink-solid-fg)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 600,
      marginTop: 2, opacity: savable ? 1 : 0.45, cursor: savable ? 'pointer' : 'default' }}>
    {L.connSave}
  </button>;
}

export function MConnectionSheet(props: ConnectionSheetProps) {
  const L = useVocab();
  const fields: FieldsProps = {
    ...props, spec: connectionFieldSpec(props.draft.kind, props.creating),
    set: (patch) => props.onChange({ ...props.draft, ...patch }),
  };
  return <MBottomSheet onClose={props.onClose}>
    <div style={{ display: 'flex', alignItems: 'baseline', padding: '0 2px 12px' }}>
      <span style={{ fontSize: 16, fontWeight: 650, color: MC.ink, letterSpacing: '-.01em' }}>
        {props.creating ? L.connCreateTitle : L.connEditTitle}
      </span>
    </div>
    {fields.spec.kindSelect ? <KindField {...fields} /> : null}
    <NameField {...fields} />
    <ProtocolField {...fields} />
    <EndpointFields {...fields} />
    <ModelsField {...fields} />
    <SaveButton savable={isConnectionFormValid(props.errors) && !props.pending} onSave={props.onSave} />
  </MBottomSheet>;
}
