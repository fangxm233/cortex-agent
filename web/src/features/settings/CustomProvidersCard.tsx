// input:  auth.customProviders tRPC, custom provider VM and Select
// output: desktop list and editor for user-defined PI providers
// pos:    Custom provider section of the desktop accounts panel
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CustomProviderApi, CustomProviderView } from '@cortex-agent/ui-contract';
import { Select, useToast } from '@/design';
import { useVocab, type Vocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import {
  CUSTOM_PROVIDER_API_OPTIONS,
  buildCustomProviderArgs,
  emptyCustomProviderForm,
  formStateFromCustomProvider,
  isCustomProviderFormValid,
  validateCustomProviderForm,
  type CustomProviderFieldError,
  type CustomProviderFormState,
} from './custom-provider-vm';
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

const FIELD_ERROR_LABEL: Record<CustomProviderFieldError, keyof Vocab> = {
  'name-required': 'cpvErrNameRequired',
  'name-charset': 'cpvErrNameCharset',
  'name-taken': 'cpvErrNameTaken',
  'upstream-required': 'cpvErrUpstreamRequired',
  'upstream-scheme': 'cpvErrUpstreamScheme',
  'models-required': 'cpvErrModelsRequired',
  'model-id-duplicate': 'cpvErrModelsDuplicate',
};

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

function ProviderRow({ provider, disabled, confirming, onEdit, onDelete }: {
  provider: CustomProviderView;
  disabled: boolean;
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
          <SButton tone="neutral" data-cpv-action="edit" disabled={disabled} onClick={onEdit}>{L.cpvEdit}</SButton>
          <SButton tone="danger" data-cpv-action="delete" disabled={disabled} onClick={onDelete}>
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
  errors: ReturnType<typeof validateCustomProviderForm>;
  onChange: (next: CustomProviderFormState) => void;
}) {
  const L = useVocab();
  const set = (patch: Partial<CustomProviderFormState>) => onChange({ ...draft, ...patch });
  const hint = (field: keyof typeof errors, fallback?: ReactNode) => {
    const code = errors[field];
    return code ? L[FIELD_ERROR_LABEL[code]] : fallback;
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
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = useState<CustomProviderFormState | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const list = useQuery(trpc.auth.customProviders.queryOptions({}));
  const providers = list.data ?? [];

  const refresh = (): void => {
    void queryClient.invalidateQueries(trpc.auth.customProviders.queryFilter({}));
    void queryClient.invalidateQueries(trpc.auth.status.queryFilter({}));
  };
  const failed = (error: { message: string }) => toast({ title: `${L.cpvToastFailed}: ${error.message}`, tone: 'failed' });

  const save = useMutation(trpc.auth.upsertCustomProvider.mutationOptions({
    onSuccess: () => {
      refresh();
      setDraft(null);
      toast({ title: L.cpvToastSaved, tone: 'done' });
    },
    onError: failed,
  }));
  const remove = useMutation(trpc.auth.removeCustomProvider.mutationOptions({
    onSuccess: () => {
      refresh();
      setConfirming(null);
      toast({ title: L.cpvToastDeleted, tone: 'done' });
    },
    onError: failed,
  }));

  const busy = save.isPending || remove.isPending;
  const errors = draft
    ? validateCustomProviderForm(draft, {
      mode: creating ? 'create' : 'update',
      existingNames: providers.map((provider) => provider.name),
    })
    : {};

  const openCreate = (): void => {
    setCreating(true);
    setDraft(emptyCustomProviderForm());
  };
  const openEdit = (provider: CustomProviderView): void => {
    setCreating(false);
    setDraft(formStateFromCustomProvider(provider));
  };
  // Two-step delete: the first click arms the row, the second one removes the gateway route the
  // running gateway is currently serving.
  const requestDelete = (name: string): void => {
    if (confirming !== name) {
      setConfirming(name);
      return;
    }
    remove.mutate({ name });
  };

  return (
    <SCard style={{ marginTop: 12, maxWidth: 980, overflow: 'hidden' }}>
      <SCardHeader
        title={L.cpvTitle}
        right={(
          <SButton tone="accent" data-cpv-action="new" disabled={busy || draft !== null} onClick={openCreate}>
            {L.cpvNew}
          </SButton>
        )}
      />
      <div style={{ padding: '8px 14px 0', font: `400 10px ${MONO}`, color: 'var(--proto-muted-3)' }}>
        {L.cpvSubtitle}
      </div>
      {providers.length > 0
        ? providers.map((provider) => (
          <ProviderRow
            key={provider.name} provider={provider} disabled={busy}
            confirming={confirming === provider.name}
            onEdit={() => openEdit(provider)}
            onDelete={() => requestDelete(provider.name)}
          />
        ))
        : <div style={{ padding: '12px 14px', color: 'var(--proto-muted-3)', fontSize: 11 }}>{L.cpvNone}</div>}
      {draft ? (
        <div style={{ padding: '4px 14px 14px' }}>
          <Editor draft={draft} creating={creating} errors={errors} onChange={setDraft} />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 10 }}>
            <SButton tone="neutral" data-cpv-action="cancel" disabled={busy} onClick={() => setDraft(null)}>{L.cpvCancel}</SButton>
            <SButton
              tone="accent" data-cpv-action="save"
              disabled={busy || !isCustomProviderFormValid(errors)}
              onClick={() => save.mutate(buildCustomProviderArgs(draft))}
            >
              {L.cpvSave}
            </SButton>
          </div>
        </div>
      ) : null}
    </SCard>
  );
}
