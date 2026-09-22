// input:  redacted fields, local drafts and credential transport state
// output: accessible write-only credential fields and clear controls
// pos:    Platform connection fields and optional disclosure
// >>> Once updated, update this header and parent AGENTS.md <<<

import type { CSSProperties } from 'react';
import type { PlatformFieldSnapshot } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';
import { FIELD_LABELS, type PlatformDraft } from './platform-settings-vm';
import { PS_HINT_STYLE, psFieldStyle } from './platform-ui';
import { SFieldRow, SLinkAction } from './settings-ui';

const SUMMARY_STYLE: CSSProperties = {
  cursor: 'pointer', padding: '6px 0', fontSize: 11.5, fontWeight: 600, color: 'var(--proto-muted)',
};

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
  return <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
    <span>{clearing ? L.psWillClear : field.present ? L.psStored : field.runtimePresent ? L.psInherited : L.psNotStored}</span>
    {field.present && <SLinkAction disabled={disabled} onClick={clear}>
      {clearing ? L.psUndoClear : L.psClear}
    </SLinkAction>}
  </span>;
}

function FieldInput({ field, draft, disabled, onChange }: FieldProps) {
  const L = useVocab();
  const value = draft[field.key] ?? (field.secret ? '' : field.value ?? '');
  const locked = disabled || draft[field.key] === null;
  if (field.key === 'FEISHU_DOMAIN') return <select id={`ps-${field.key}`} value={value || 'feishu'}
    disabled={disabled} onChange={e => onChange(field.key, e.target.value)} style={psFieldStyle(disabled)}>
    <option value="feishu">Feishu · 飞书</option><option value="lark">Lark · International</option>
  </select>;
  return <input id={`ps-${field.key}`} name={field.key} type={field.secret ? 'password' : 'text'}
    value={value} autoComplete="off" spellCheck={false} maxLength={4096} disabled={locked}
    placeholder={field.secret ? (field.present ? L.psStored : L.psNotStored) : undefined}
    onChange={e => onChange(field.key, e.target.value)} style={psFieldStyle(locked)} />;
}

// The label element stays inside the kit's label slot so the field keeps its `htmlFor` binding.
function ConnectionField(props: FieldProps) {
  const L = useVocab();
  return <div data-platform-field={props.field.key}>
    <SFieldRow
      label={<label htmlFor={`ps-${props.field.key}`}>{L[FIELD_LABELS[props.field.key]]}</label>}
      hint={props.field.secret ? <SecretControls {...props} /> : undefined}
    >
      <FieldInput {...props} />
    </SFieldRow>
  </div>;
}

export function PlatformConnectionFields(props: {
  fields: PlatformFieldSnapshot[]; draft: PlatformDraft; disabled: boolean; onChange: FieldProps['onChange'];
}) {
  const L = useVocab();
  const optional = (field: PlatformFieldSnapshot) => ['FEISHU_ENCRYPT_KEY', 'FEISHU_VERIFICATION_TOKEN'].includes(field.key);
  const render = (field: PlatformFieldSnapshot) => <ConnectionField key={field.key} field={field} {...props} />;
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 14 }}>
    {props.fields.filter(field => !optional(field)).map(render)}
    {props.fields.some(optional) && <details style={{ color: 'var(--proto-muted)' }}>
      <summary className="settings-platform-summary" style={SUMMARY_STYLE}>{L.psOptional}</summary>
      {props.fields.filter(optional).map(render)}
    </details>}
    <p style={PS_HINT_STYLE}>{L.psSecretHint}</p>
  </div>;
}
