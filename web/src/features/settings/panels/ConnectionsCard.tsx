import type { ReactNode } from 'react';
import type { CustomProviderApi } from '@cortex-agent/ui-contract';
import { Select } from '@/design';
import { useVocab, type Vocab } from '@/i18n';
import {
  CLAUDE_AUTH_STYLES,
  CONNECTION_DELETE_RISK_VOCAB_KEYS,
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
  type ConnectionRowVm,
} from '@/features/settings/vm/connections-vm';
import { useConnectionsController } from '@/features/settings/controllers/useConnectionsController';
import {
  SButton,
  SCount,
  SDot,
  SEntityName,
  SEntityRow,
  SFieldRow,
  SLinkAction,
  SMeta,
  SNotice,
  SRowGroup,
  SSection,
  SSubheading,
  S_CONTROL_DISABLED_STYLE,
  S_CONTROL_STYLE,
} from '@/features/settings/ui/settings-ui';

type Controller = ReturnType<typeof useConnectionsController>;

function RowActions({ row, controller }: { row: ConnectionRowVm; controller: Controller }) {
  const L = useVocab();
  const confirming = controller.confirmingDelete === row.key;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      {confirming ? <SMeta data-conn-risk="" style={{ color: 'var(--proto-danger)' }}>{L[CONNECTION_DELETE_RISK_VOCAB_KEYS[row.kind]]}</SMeta> : null}
      <SButton tone="neutral" data-conn-action="edit" disabled={controller.savePending}
        onClick={() => controller.openEdit(row)}>{L.connEdit}</SButton>
      <SButton tone="danger" data-conn-action="delete" disabled={controller.removePending}
        onClick={() => controller.requestDelete(row)}>
        {confirming ? L.connConfirmDelete : L.connDelete}
      </SButton>
    </div>
  );
}

function ConnectionRow({ row, controller }: { row: ConnectionRowVm; controller: Controller }) {
  const L = useVocab();
  return (
    <SEntityRow
      data-connection={row.key}
      dot={<SDot color={row.keyHint ? 'var(--proto-success)' : 'var(--proto-muted-2)'} />}
      name={(
        <>
          <SEntityName>{row.id}</SEntityName>
          <SMeta>{L[CONNECTION_KIND_VOCAB_KEYS[row.kind]]}</SMeta>
          {row.apiKeySlot ? <SMeta data-conn-api-key-slot="">{L.authLoginApiKey}</SMeta> : null}
        </>
      )}
      meta={row.meta}
      metaCode
      trailing={(
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, minWidth: 0, maxWidth: '100%' }}>
          <SMeta data-conn-key-hint="">{row.keyHint ?? L.connNoKey}</SMeta>
          <RowActions row={row} controller={controller} />
        </div>
      )}
    />
  );
}

interface FieldsProps {
  draft: ConnectionFormState;
  spec: ConnectionFieldSpec;
  errors: ConnectionFormErrors;
  overridable: string[];
  kinds: ConnectionFormKind[];
  set: (patch: Partial<ConnectionFormState>) => void;
}

function fieldHint(L: Vocab, errors: ConnectionFormErrors, field: keyof ConnectionFormErrors, fallback?: ReactNode) {
  return connectionFieldErrorCopy(errors[field], L) ?? fallback;
}

function fieldTone(errors: ConnectionFormErrors, field: keyof ConnectionFormErrors) {
  return errors[field] ? ('danger' as const) : ('muted' as const);
}

/** A kind switch on create starts a fresh form of that kind, keeping what was typed in common. */
function KindField({ draft, kinds, set }: FieldsProps) {
  const L = useVocab();
  return (
    <SFieldRow label={L.connFieldKind}>
      <Select popupClassName="settings-surface settings-select-popup" data-conn-field="kind" aria-label={L.connFieldKind}
        value={draft.kind} options={kinds.map((kind) => ({ value: kind, label: L[CONNECTION_KIND_VOCAB_KEYS[kind]] }))}
        onValueChange={(kind: ConnectionFormKind) => set({ ...emptyConnectionForm(kind), key: draft.key, baseUrl: draft.baseUrl })}
        style={S_CONTROL_STYLE} />
    </SFieldRow>
  );
}

function NameField({ draft, spec, errors, overridable, set }: FieldsProps) {
  const L = useVocab();
  const hint = fieldHint(L, errors, 'name', spec.kindSelect ? L.connNameHint : L.connNoRename);
  const control = spec.nameSelect
    ? <Select popupClassName="settings-surface settings-select-popup" data-conn-field="name" aria-label={L[spec.nameLabel]}
        value={draft.name} options={overridable.map((provider) => ({ value: provider, label: provider }))}
        onValueChange={(name: string) => set({ name })} style={S_CONTROL_STYLE} />
    : <input data-conn-field="name" value={draft.name} disabled={!spec.kindSelect}
        onChange={(e) => set({ name: e.target.value })} style={spec.kindSelect ? S_CONTROL_STYLE : S_CONTROL_DISABLED_STYLE} />;
  return <SFieldRow label={L[spec.nameLabel]} hint={hint} hintTone={fieldTone(errors, 'name')}>{control}</SFieldRow>;
}

function ProtocolFields({ draft, spec, set }: FieldsProps) {
  const L = useVocab();
  if (spec.api) {
    return (
      <SFieldRow label={L.connFieldApi}>
        <Select popupClassName="settings-surface settings-select-popup" data-conn-field="api" aria-label={L.connFieldApi}
          value={draft.api} options={CUSTOM_PROVIDER_API_OPTIONS.map((api) => ({ value: api, label: api }))}
          onValueChange={(api: CustomProviderApi) => set({ api })} style={S_CONTROL_STYLE} />
      </SFieldRow>
    );
  }
  if (!spec.authStyle) return null;
  return (
    <SFieldRow label={L.connFieldAuth}>
      <Select popupClassName="settings-surface settings-select-popup" data-conn-field="auth" aria-label={L.connFieldAuth}
        value={draft.authStyle} options={CLAUDE_AUTH_STYLES.map((style) => ({ value: style, label: style }))}
        onValueChange={(authStyle: ClaudeAuthStyle) => set({ authStyle })} style={S_CONTROL_STYLE} />
    </SFieldRow>
  );
}

function EndpointFields({ draft, spec, errors, set }: FieldsProps) {
  const L = useVocab();
  const placeholder = spec.kindSelect ? undefined : L.connKeyPlaceholder;
  return (
    <>
      <SFieldRow label={L.connFieldUrl} hint={fieldHint(L, errors, 'baseUrl', spec.urlHint ? L[spec.urlHint] : undefined)}
        hintTone={fieldTone(errors, 'baseUrl')}>
        <input data-conn-field="url" value={draft.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} style={S_CONTROL_STYLE} />
      </SFieldRow>
      <SFieldRow label={L.connFieldKey} hint={fieldHint(L, errors, 'key', spec.keyHint ? L[spec.keyHint] : undefined)}
        hintTone={fieldTone(errors, 'key')}>
        <input data-conn-field="key" type="password" autoComplete="new-password" value={draft.key} placeholder={placeholder}
          onChange={(e) => set({ key: e.target.value })} style={S_CONTROL_STYLE} />
      </SFieldRow>
    </>
  );
}

function ModelsField({ draft, spec, errors, set }: FieldsProps) {
  const L = useVocab();
  if (!spec.models) return null;
  return (
    <SFieldRow label={L.connFieldModels} hint={fieldHint(L, errors, 'models', L[spec.modelsHint])} hintTone={fieldTone(errors, 'models')}>
      <textarea data-conn-field="models" value={draft.models} rows={3} onChange={(e) => set({ models: e.target.value })}
        style={{ ...S_CONTROL_STYLE, height: 'auto', minHeight: 80, resize: 'vertical' }} />
    </SFieldRow>
  );
}

function Editor({ controller, draft }: { controller: Controller; draft: ConnectionFormState }) {
  const spec = connectionFieldSpec(draft.kind, controller.creating);
  const props: FieldsProps = {
    draft, spec, errors: controller.errors, overridable: controller.overridable, kinds: controller.kinds,
    set: (patch) => controller.changeDraft({ ...draft, ...patch }),
  };
  return (
    <>
      {spec.kindSelect ? <KindField {...props} /> : null}
      <NameField {...props} />
      <ProtocolFields {...props} />
      <EndpointFields {...props} />
      <ModelsField {...props} />
    </>
  );
}

function EditorCard({ controller, draft }: { controller: Controller; draft: ConnectionFormState }) {
  const L = useVocab();
  return (
    <div data-conn-editor="" style={{ borderTop: '1px solid var(--proto-line-2)', paddingBottom: 4 }}>
      <SSubheading>{controller.creating ? L.connCreateTitle : L.connEditTitle}</SSubheading>
      <div style={{ paddingTop: 8 }}>
        <Editor controller={controller} draft={draft} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <SButton tone="neutral" data-conn-action="cancel" disabled={controller.savePending}
            onClick={controller.closeDraft}>{L.connCancel}</SButton>
          <SButton tone="primary" data-conn-action="save"
            disabled={controller.savePending || !isConnectionFormValid(controller.errors)}
            onClick={controller.save}>{L.connSave}</SButton>
        </div>
      </div>
    </div>
  );
}

function ConnectionList({ controller }: { controller: Controller }) {
  const L = useVocab();
  if (controller.rows.length === 0) return <div style={{ marginTop: 8 }}><SNotice tone="muted">{L.connNone}</SNotice></div>;
  return (
    <SRowGroup>
      {controller.rows.map((row) => <ConnectionRow key={row.key} row={row} controller={controller} />)}
    </SRowGroup>
  );
}

/**
 * The connections Cortex stores — Claude keys and relays, PI endpoint overrides, custom PI
 * providers — edited directly. The `api` row is the API-key slot above: one record, two views.
 * Names stay fixed because saved model selections bind to them.
 */
export function ConnectionsCard() {
  const L = useVocab();
  const controller = useConnectionsController();
  const label = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
      {L.connTitle}
      <SCount tone="quiet">{controller.rows.length}</SCount>
    </span>
  );
  const add = (
    <SLinkAction data-conn-action="new" disabled={controller.savePending || controller.draft !== null}
      onClick={controller.openCreate}>
      {L.connNew}
    </SLinkAction>
  );
  return (
    <SSection label={label} action={add}>
      <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--proto-muted-2)' }}>{L.connSubtitle}</div>
      <ConnectionList controller={controller} />
      {controller.draft ? <EditorCard controller={controller} draft={controller.draft} /> : null}
    </SSection>
  );
}
