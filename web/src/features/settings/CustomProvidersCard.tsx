// input:  shared custom-provider controller/VM, Select, and desktop settings primitives
// output: desktop list and editor with view-owned operation gates
// pos:    Desktop custom-provider view over canonical settings ownership
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { ReactNode } from 'react';
import type { CustomProviderApi, CustomProviderView } from '@cortex-agent/ui-contract';
import { Select } from '@/design';
import { useVocab } from '@/i18n';
import {
  CUSTOM_PROVIDER_API_OPTIONS,
  customProviderFieldErrorCopy,
  isCustomProviderFormValid,
  type CustomProviderFormErrors,
  type CustomProviderFormState,
} from './custom-provider-vm';
import { useCustomProvidersController } from './useCustomProvidersController';
import {
  SButton,
  SCard,
  SCardHeader,
  SFieldRow,
  SSectionLabel,
  S_CONTROL_DISABLED_STYLE,
  S_CONTROL_STYLE,
} from './settings-ui';

const MONO = "'IBM Plex Mono',monospace";

function Tag({ children, tone }: { children: ReactNode; tone: 'muted' | 'warn' }) {
  return (
    <span style={{
      font: `600 9px ${MONO}`,
      color: tone === 'warn' ? 'var(--proto-amber-fg)' : 'var(--proto-muted-2)',
      border: '1px solid var(--proto-line-2)',
      borderRadius: 999,
      padding: '2px 7px',
    }}>
      {children}
    </span>
  );
}

function ProviderRow({ provider, editDisabled, deleteDisabled, confirming, onEdit, onDelete }: {
  provider: CustomProviderView;
  editDisabled: boolean;
  deleteDisabled: boolean;
  confirming: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const L = useVocab();
  return (
    <div
      data-custom-provider={provider.name}
      style={{ padding: '11px 14px', borderBottom: '1px solid var(--proto-alt)' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 650, color: 'var(--proto-ink)' }}>{provider.name}</span>
        <span style={{ font: `400 9px ${MONO}`, color: 'var(--proto-muted-3)' }}>{provider.api}</span>
        {provider.routed ? null : <Tag tone="warn">{L.cpvUnrouted}</Tag>}
        <Tag tone="muted">{provider.hasApiKey ? L.cpvKeyStored : L.cpvNoKey}</Tag>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
        <span style={{ font: `400 9.5px ${MONO}`, color: 'var(--proto-muted-2)', overflowWrap: 'anywhere' }}>
          {provider.upstreamUrl ?? '—'}
        </span>
        <span style={{ font: `400 9.5px ${MONO}`, color: 'var(--proto-muted-2)', overflowWrap: 'anywhere' }}>
          {provider.models.map((model) => model.id).join(', ')}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <SButton tone="neutral" data-cpv-action="edit" disabled={editDisabled} onClick={onEdit}>{L.cpvEdit}</SButton>
          <SButton tone="danger" data-cpv-action="delete" disabled={deleteDisabled} onClick={onDelete}>
            {confirming ? L.cpvConfirmDelete : L.cpvDelete}
          </SButton>
        </span>
      </div>
    </div>
  );
}

function Editor({ draft, creating, errors, onChange }: {
  draft: CustomProviderFormState;
  creating: boolean;
  errors: CustomProviderFormErrors;
  onChange: (next: CustomProviderFormState) => void;
}) {
  const L = useVocab();
  const set = (patch: Partial<CustomProviderFormState>) => onChange({ ...draft, ...patch });
  const hint = (field: keyof typeof errors, fallback?: ReactNode) => {
    return customProviderFieldErrorCopy(errors[field], L) ?? fallback;
  };
  const tone = (field: keyof typeof errors) => (errors[field] ? ('danger' as const) : ('muted' as const));

  return (
    <>
      <SSectionLabel>{creating ? L.cpvCreateTitle : L.cpvEditTitle}</SSectionLabel>
      <SFieldRow
        label={L.cpvFieldName}
        hint={hint('name', creating ? L.cpvNameHint : L.cpvNoRename)}
        hintTone={tone('name')}
      >
        <input
          data-cpv-field="name" value={draft.name} disabled={!creating}
          onChange={(e) => set({ name: e.target.value })}
          style={creating ? S_CONTROL_STYLE : S_CONTROL_DISABLED_STYLE}
        />
      </SFieldRow>
      <SFieldRow label={L.cpvFieldApi} hint={L.cpvApiHint}>
        <Select
          data-cpv-field="api"
          aria-label={L.cpvFieldApi}
          value={draft.api}
          options={CUSTOM_PROVIDER_API_OPTIONS.map((api) => ({ value: api, label: api }))}
          onValueChange={(api: CustomProviderApi) => set({ api })}
          style={S_CONTROL_STYLE}
        />
      </SFieldRow>
      <SFieldRow label={L.cpvFieldUrl} hint={hint('upstreamUrl', L.cpvUrlHint)} hintTone={tone('upstreamUrl')}>
        <input
          data-cpv-field="url" value={draft.upstreamUrl}
          onChange={(e) => set({ upstreamUrl: e.target.value })}
          style={S_CONTROL_STYLE}
        />
      </SFieldRow>
      <SFieldRow label={L.cpvFieldKey} hint={L.cpvKeyHint}>
        <input
          data-cpv-field="key" type="password" value={draft.apiKey} placeholder={L.cpvKeyPlaceholder}
          onChange={(e) => set({ apiKey: e.target.value })}
          style={S_CONTROL_STYLE}
        />
      </SFieldRow>
      <SFieldRow label={L.cpvFieldModels} hint={hint('models', L.cpvModelsHint)} hintTone={tone('models')}>
        <textarea
          data-cpv-field="models" value={draft.models} rows={3}
          onChange={(e) => set({ models: e.target.value })}
          style={{ ...S_CONTROL_STYLE, resize: 'vertical' }}
        />
      </SFieldRow>
    </>
  );
}

/**
 * Custom providers are defined, not logged into: their credential lives in the gateway route, so the
 * account list above has nothing to offer them. Editing a name is refused for the same reason a
 * profile name cannot change — profiles bind to it.
 */
export function CustomProvidersCard() {
  const L = useVocab();
  const controller = useCustomProvidersController();
  return (
    <SCard style={{ marginTop: 12, maxWidth: 980, overflow: 'hidden' }}>
      <SCardHeader title={L.cpvTitle} right={(
        <SButton tone="accent" data-cpv-action="new"
          disabled={controller.savePending || controller.draft !== null} onClick={controller.openCreate}>
          {L.cpvNew}
        </SButton>
      )} />
      <div style={{ padding: '8px 14px 0', font: `400 10px ${MONO}`, color: 'var(--proto-muted-3)' }}>
        {L.cpvSubtitle}
      </div>
      {controller.providers.length > 0 ? controller.providers.map(provider => (
        <ProviderRow key={provider.name} provider={provider}
          editDisabled={controller.savePending} deleteDisabled={controller.removePending}
          confirming={controller.confirmingDelete === provider.name}
          onEdit={() => controller.openEdit(provider)}
          onDelete={() => controller.requestDelete(provider.name)} />
      )) : <div style={{ padding: '12px 14px', color: 'var(--proto-muted-3)', fontSize: 11 }}>{L.cpvNone}</div>}
      {controller.draft ? (
        <div style={{ padding: '4px 14px 14px' }}>
          <Editor draft={controller.draft} creating={controller.creating}
            errors={controller.errors} onChange={controller.changeDraft} />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 10 }}>
            <SButton tone="neutral" data-cpv-action="cancel" disabled={controller.savePending}
              onClick={controller.closeDraft}>{L.cpvCancel}</SButton>
            <SButton tone="accent" data-cpv-action="save"
              disabled={controller.savePending || !isCustomProviderFormValid(controller.errors)}
              onClick={controller.save}>{L.cpvSave}</SButton>
          </div>
        </div>
      ) : null}
    </SCard>
  );
}
