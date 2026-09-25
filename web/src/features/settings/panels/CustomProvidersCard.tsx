// input:  custom provider controller, settings atoms
// output: provider cards and endpoint editor
// pos:    Desktop custom provider account forms
// >>> Once updated, update this header and parent AGENTS.md <<<

import type { ReactNode } from 'react';
import type { CustomProviderApi, CustomProviderView } from '@cortex-agent/ui-contract';
import { Select } from '@/design';
import { useVocab, type Vocab } from '@/i18n';
import {
  CUSTOM_PROVIDER_API_OPTIONS,
  customProviderFieldErrorCopy,
  isCustomProviderFormValid,
  type CustomProviderFormErrors,
  type CustomProviderFormState,
} from '@/features/settings/vm/custom-provider-vm';
import { useCustomProvidersController } from '@/features/settings/controllers/useCustomProvidersController';
import {
  SButton,
  SCard,
  SCardHeader,
  SCount,
  SDot,
  SEntityName,
  SEntityRow,
  SFieldRow,
  SLinkAction,
  SNotice,
  SPill,
  SSection,
  S_CONTROL_DISABLED_STYLE,
  S_CONTROL_STYLE,
} from '@/features/settings/ui/settings-ui';

function providerMeta(provider: CustomProviderView): string {
  const models = provider.models.map((model) => model.id).join(', ');
  return [provider.api, provider.upstreamUrl ?? '—', models].join('  ·  ');
}

function ProviderActions({ editDisabled, deleteDisabled, confirming, onEdit, onDelete }: {
  editDisabled: boolean;
  deleteDisabled: boolean;
  confirming: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <SButton tone="neutral" data-cpv-action="edit" disabled={editDisabled} onClick={onEdit}>{L.cpvEdit}</SButton>
      <SButton tone="danger" data-cpv-action="delete" disabled={deleteDisabled} onClick={onDelete}>
        {confirming ? L.cpvConfirmDelete : L.cpvDelete}
      </SButton>
    </div>
  );
}

function ProviderRow({ provider, ...actions }: {
  provider: CustomProviderView;
  editDisabled: boolean;
  deleteDisabled: boolean;
  confirming: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const L = useVocab();
  return (
    <SEntityRow
      data-custom-provider={provider.name}
      dot={<SDot color={provider.routed ? 'var(--proto-success)' : 'var(--proto-amber)'} />}
      name={(
        <>
          <SEntityName>{provider.name}</SEntityName>
          {provider.routed ? null : <SPill tone="amber">{L.cpvUnrouted}</SPill>}
        </>
      )}
      meta={providerMeta(provider)}
      trailing={(
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, minWidth: 0, maxWidth: '100%' }}>
          <SPill tone="neutral" mono>{provider.hasApiKey ? L.cpvKeyStored : L.cpvNoKey}</SPill>
          <ProviderActions {...actions} />
        </div>
      )}
    />
  );
}

interface FieldsProps {
  draft: CustomProviderFormState;
  creating: boolean;
  errors: CustomProviderFormErrors;
  set: (patch: Partial<CustomProviderFormState>) => void;
}

function fieldHint(L: Vocab, errors: CustomProviderFormErrors, field: keyof CustomProviderFormErrors, fallback?: ReactNode) {
  return customProviderFieldErrorCopy(errors[field], L) ?? fallback;
}

function fieldTone(errors: CustomProviderFormErrors, field: keyof CustomProviderFormErrors) {
  return errors[field] ? ('danger' as const) : ('muted' as const);
}

function IdentityFields({ draft, creating, errors, set }: FieldsProps) {
  const L = useVocab();
  return (
    <>
      <SFieldRow
        label={L.cpvFieldName}
        hint={fieldHint(L, errors, 'name', creating ? L.cpvNameHint : L.cpvNoRename)}
        hintTone={fieldTone(errors, 'name')}
      >
        <input
          data-cpv-field="name" value={draft.name} disabled={!creating}
          onChange={(e) => set({ name: e.target.value })}
          style={creating ? S_CONTROL_STYLE : S_CONTROL_DISABLED_STYLE}
        />
      </SFieldRow>
      <SFieldRow label={L.cpvFieldApi} hint={L.cpvApiHint}>
        <Select popupClassName="settings-surface settings-select-popup"
          data-cpv-field="api"
          aria-label={L.cpvFieldApi}
          value={draft.api}
          options={CUSTOM_PROVIDER_API_OPTIONS.map((api) => ({ value: api, label: api }))}
          onValueChange={(api: CustomProviderApi) => set({ api })}
          style={S_CONTROL_STYLE}
        />
      </SFieldRow>
    </>
  );
}

function EndpointFields({ draft, errors, set }: Omit<FieldsProps, 'creating'>) {
  const L = useVocab();
  return (
    <>
      <SFieldRow label={L.cpvFieldUrl} hint={fieldHint(L, errors, 'upstreamUrl', L.cpvUrlHint)} hintTone={fieldTone(errors, 'upstreamUrl')}>
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
      <SFieldRow label={L.cpvFieldModels} hint={fieldHint(L, errors, 'models', L.cpvModelsHint)} hintTone={fieldTone(errors, 'models')}>
        <textarea
          data-cpv-field="models" value={draft.models} rows={3}
          onChange={(e) => set({ models: e.target.value })}
          style={{ ...S_CONTROL_STYLE, height: 'auto', minHeight: 80, resize: 'vertical' }}
        />
      </SFieldRow>
    </>
  );
}

function Editor({ draft, creating, errors, onChange }: {
  draft: CustomProviderFormState;
  creating: boolean;
  errors: CustomProviderFormErrors;
  onChange: (next: CustomProviderFormState) => void;
}) {
  const set = (patch: Partial<CustomProviderFormState>) => onChange({ ...draft, ...patch });
  return (
    <>
      <IdentityFields draft={draft} creating={creating} errors={errors} set={set} />
      <EndpointFields draft={draft} errors={errors} set={set} />
    </>
  );
}

type Controller = ReturnType<typeof useCustomProvidersController>;

function EditorCard({ controller, draft }: { controller: Controller; draft: CustomProviderFormState }) {
  const L = useVocab();
  return (
    <SCard style={{ overflow: 'hidden' }}>
      <SCardHeader title={controller.creating ? L.cpvCreateTitle : L.cpvEditTitle} />
      <div style={{ padding: '10px 16px 14px' }}>
        <Editor draft={draft} creating={controller.creating}
          errors={controller.errors} onChange={controller.changeDraft} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <SButton tone="neutral" data-cpv-action="cancel" disabled={controller.savePending}
            onClick={controller.closeDraft}>{L.cpvCancel}</SButton>
          <SButton tone="accent" data-cpv-action="save"
            disabled={controller.savePending || !isCustomProviderFormValid(controller.errors)}
            onClick={controller.save}>{L.cpvSave}</SButton>
        </div>
      </div>
    </SCard>
  );
}

function ProviderList({ controller }: { controller: Controller }) {
  const L = useVocab();
  if (controller.providers.length === 0) return <SNotice tone="muted">{L.cpvNone}</SNotice>;
  return (
    <>
      {controller.providers.map(provider => (
        <ProviderRow key={provider.name} provider={provider}
          editDisabled={controller.savePending} deleteDisabled={controller.removePending}
          confirming={controller.confirmingDelete === provider.name}
          onEdit={() => controller.openEdit(provider)}
          onDelete={() => controller.requestDelete(provider.name)} />
      ))}
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
  const label = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
      {L.cpvTitle}
      <SCount tone="accent">{controller.providers.length}</SCount>
    </span>
  );
  const add = (
    <SLinkAction data-cpv-action="new" disabled={controller.savePending || controller.draft !== null}
      onClick={controller.openCreate}>
      {L.cpvNew}
    </SLinkAction>
  );
  return (
    <SSection label={label} action={add}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--proto-muted-2)', padding: '0 2px' }}>
          {L.cpvSubtitle}
        </div>
        <ProviderList controller={controller} />
        {controller.draft ? <EditorCard controller={controller} draft={controller.draft} /> : null}
      </div>
    </SSection>
  );
}
