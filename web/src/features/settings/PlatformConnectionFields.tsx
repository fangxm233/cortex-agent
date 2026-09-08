// input:  redacted fields, local drafts and credential transport state
// output: accessible write-only credential fields and clear controls
// pos:    Shared platform connection form fields
// >>> Once updated, update this header and parent CORTEX.md <<<

import type { PlatformFieldSnapshot } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';
import { FIELD_LABELS, type PlatformDraft } from './platform-settings-vm';

interface FieldProps {
  field: PlatformFieldSnapshot;
  draft: PlatformDraft;
  disabled: boolean;
  onChange: (key: PlatformFieldSnapshot['key'], value: string | null) => void;
}

function SecretControls({ field, draft, disabled, onChange }: FieldProps) {
  const L = useVocab();
  const clearing = draft[field.key] === null;
  const clear = () => {
    if (clearing) { onChange(field.key, ''); return; }
    if (window.confirm(L.psClearConfirm)) onChange(field.key, null);
  };
  return <div className="ps-field-note">
    <span>{clearing ? L.psWillClear : field.present ? L.psStored : field.runtimePresent ? L.psInherited : L.psNotStored}</span>
    {field.present && <button type="button" disabled={disabled} onClick={clear} className="ps-link">
      {clearing ? L.psUndoClear : L.psClear}
    </button>}
  </div>;
}

function FieldInput({ field, draft, disabled, onChange }: FieldProps) {
  const L = useVocab();
  const value = draft[field.key] ?? (field.secret ? '' : field.value ?? '');
  if (field.key === 'FEISHU_DOMAIN') return <select id={`ps-${field.key}`} value={value || 'feishu'}
    disabled={disabled} onChange={e => onChange(field.key, e.target.value)}>
    <option value="feishu">Feishu · 飞书</option><option value="lark">Lark · International</option>
  </select>;
  return <input id={`ps-${field.key}`} name={field.key} type={field.secret ? 'password' : 'text'}
    value={value} autoComplete="off" spellCheck={false} maxLength={4096} disabled={disabled || draft[field.key] === null}
    placeholder={field.secret ? (field.present ? L.psStored : L.psNotStored) : undefined}
    onChange={e => onChange(field.key, e.target.value)} />;
}

function ConnectionField(props: FieldProps) {
  const L = useVocab();
  return <div className="ps-field" data-platform-field={props.field.key}>
    <label htmlFor={`ps-${props.field.key}`}>{L[FIELD_LABELS[props.field.key]]}</label>
    <FieldInput {...props} />
    {props.field.secret && <SecretControls {...props} />}
  </div>;
}

export function PlatformConnectionFields(props: {
  fields: PlatformFieldSnapshot[]; draft: PlatformDraft; disabled: boolean; onChange: FieldProps['onChange'];
}) {
  const L = useVocab();
  const optional = (field: PlatformFieldSnapshot) => ['FEISHU_ENCRYPT_KEY', 'FEISHU_VERIFICATION_TOKEN'].includes(field.key);
  const render = (field: PlatformFieldSnapshot) => <ConnectionField key={field.key} field={field} {...props} />;
  return <>
    {props.fields.filter(field => !optional(field)).map(render)}
    {props.fields.some(optional) && <details className="ps-optional"><summary>{L.psOptional}</summary>
      {props.fields.filter(optional).map(render)}
    </details>}
    <p className="ps-hint">{L.psSecretHint}</p>
  </>;
}
