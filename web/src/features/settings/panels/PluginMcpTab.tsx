import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PluginsMcpRead, UiPluginCatalogEntry } from '@cortex-agent/ui-contract';
import { Select } from '@/design';
import { useVocab, type Vocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { SButton, SFieldRow, SNotice, SRowGroup, S_CONTROL_STYLE } from '@/features/settings/ui/settings-ui';
import { EmptyMessage, ROW } from '@/features/settings/ui/plugin-ui';
import {
  draftsFromRead, emptyDraft, mcpDraftIssues, replaceDraft, sameMcpDrafts, toInput,
  type McpSecretRow, type McpServerDraft, type McpTransport,
} from '@/features/settings/vm/plugin-authoring-vm';
import type { PluginAuthoringActions } from '@/features/settings/controllers/usePluginAuthoring';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function transportOptions(L: Vocab) {
  return [
    { value: 'stdio' as const, label: L.plTransportStdio },
    { value: 'streamable-http' as const, label: L.plTransportHttp },
    { value: 'sse' as const, label: L.plTransportSse },
  ];
}

function SecretRows(props: {
  draft: McpServerDraft;
  label: string;
  onChange: (secrets: McpSecretRow[]) => void;
}) {
  const L = useVocab();
  const update = (index: number, patch: Partial<McpSecretRow>) => {
    props.onChange(props.draft.secrets.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  return (
    <SFieldRow label={props.label} hint={L.plMcpSecretNote}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {props.draft.secrets.map((row, index) => (
          <div key={`${props.draft.id}:${index}`} data-plugin-secret={row.key} className="settings-secret-fields">
            <input data-field="secret-key" value={row.key} placeholder={L.plMcpKeyPh}
              onChange={(event) => update(index, { key: event.target.value })}
              style={S_CONTROL_STYLE} />
            {row.value === null
              ? (
                <>
                  <span style={{ fontSize: 12, color: 'var(--proto-muted-2)', flex: '1 1 100px' }}>{L.plMcpSecretKept}</span>
                  <SButton tone="neutral" data-action="secret-replace" onClick={() => update(index, { value: '' })}>
                    {L.plMcpSecretReplace}
                  </SButton>
                </>
              )
              : (
                <input data-field="secret-value" value={row.value} placeholder={L.plMcpSecretPh}
                  onChange={(event) => update(index, { value: event.target.value })}
                  style={S_CONTROL_STYLE} />
              )}
            <SButton tone="danger" data-action="secret-remove"
              onClick={() => props.onChange(props.draft.secrets.filter((_, i) => i !== index))}>
              {L.plMcpRemove}
            </SButton>
          </div>
        ))}
        <div>
          <SButton tone="neutral" data-action="secret-add"
            onClick={() => props.onChange([...props.draft.secrets, { key: '', value: '' }])}>
            {L.plMcpAddKey}
          </SButton>
        </div>
      </div>
    </SFieldRow>
  );
}

function ServerForm(props: {
  draft: McpServerDraft;
  onChange: (patch: Partial<McpServerDraft>) => void;
  onRemove: () => void;
}) {
  const L = useVocab();
  const stdio = props.draft.type === 'stdio';
  return (
    <div data-plugin-mcp-server={props.draft.id} style={{ ...ROW, gap: 4 }}>
      <SFieldRow label={L.plMcpName}>
        <input data-field="mcp-name" value={props.draft.name}
          onChange={(event) => props.onChange({ name: event.target.value })} style={S_CONTROL_STYLE} />
      </SFieldRow>
      <SFieldRow label={L.plMcpTransport}>
        <Select popupClassName="settings-surface settings-select-popup" value={props.draft.type} options={transportOptions(L)} style={S_CONTROL_STYLE}
          onValueChange={(value: McpTransport) => props.onChange({ type: value })} />
      </SFieldRow>
      {stdio ? (
        <>
          <SFieldRow label={L.plMcpCommand}>
            <input data-field="mcp-command" value={props.draft.command}
              onChange={(event) => props.onChange({ command: event.target.value })} style={S_CONTROL_STYLE} />
          </SFieldRow>
          <SFieldRow label={L.plMcpArgs}>
            <textarea data-field="mcp-args" value={props.draft.argsText} placeholder={L.plMcpArgsPh}
              onChange={(event) => props.onChange({ argsText: event.target.value })}
              style={{ ...S_CONTROL_STYLE, minHeight: 52, resize: 'vertical' }} />
          </SFieldRow>
          <SFieldRow label={L.plMcpCwd}>
            <input data-field="mcp-cwd" value={props.draft.cwd}
              onChange={(event) => props.onChange({ cwd: event.target.value })} style={S_CONTROL_STYLE} />
          </SFieldRow>
        </>
      ) : (
        <SFieldRow label={L.plMcpUrl}>
          <input data-field="mcp-url" value={props.draft.url}
            onChange={(event) => props.onChange({ url: event.target.value })} style={S_CONTROL_STYLE} />
        </SFieldRow>
      )}
      <SecretRows draft={props.draft} label={stdio ? L.plMcpEnv : L.plMcpHeaders}
        onChange={(secrets) => props.onChange({ secrets })} />
      <div style={{ display: 'flex', marginTop: 4 }}>
        <SButton tone="danger" data-action="mcp-remove-server" onClick={props.onRemove}>{L.plMcpRemove}</SButton>
      </div>
    </div>
  );
}

function ConvertNotice(props: { pluginId: string; busy: boolean; actions: PluginAuthoringActions }) {
  const L = useVocab();
  return (
    <SNotice tone="amber" data-plugin-mcp-unsupported=""
      action={(
        <SButton tone="primary" data-action="mcp-convert" disabled={props.busy}
          onClick={() => props.actions.convertToPortable({ id: props.pluginId })}>
          {L.plConvertPortable}
        </SButton>
      )}>
      <span style={{ display: 'block' }}>{L.plMcpLegacyNote}</span>
    </SNotice>
  );
}

/** The drafts being edited and the hash of the mcp.json they started from. */
interface McpForm {
  drafts: McpServerDraft[];
  baseHash: string;
}

function formFromRead(read: PluginsMcpRead): McpForm {
  return { drafts: draftsFromRead(read), baseHash: read.baseHash };
}

/** The read and the form seeded from it. The form keeps its hash until a save succeeds, so a save
 *  after someone else changed mcp.json is refused rather than overwriting that change. */
function useMcpForm(pluginId: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const query = useQuery(trpc.plugins.mcpRead.queryOptions({ pluginId }));
  const [form, setForm] = useState<McpForm | null>(null);

  useEffect(() => {
    setForm(null);
  }, [pluginId]);
  useEffect(() => {
    const data = query.data;
    if (data) setForm((current) => current ?? formFromRead(data));
  }, [query.data]);

  // The shared action controller refreshes the catalog list, not every per-plugin query.
  const refresh = () => queryClient.invalidateQueries(trpc.plugins.mcpRead.queryFilter({ pluginId }));
  return { query, form, setForm, refresh };
}

/** Split from {@link PluginMcpTab} so the legacy branch renders without a query client at all:
 *  hooks cannot be skipped, and a legacy plugin has no mcp.json worth reading. */
function McpServerForms(props: { plugin: UiPluginCatalogEntry; actions: PluginAuthoringActions }) {
  const L = useVocab();
  const { query, form, setForm, refresh } = useMcpForm(props.plugin.id);
  const [nextId, setNextId] = useState(0);

  if (query.isError) {
    return <EmptyMessage text={`${L.plMcpSaveFailed} ${errorMessage(query.error)}`} dataAttr="data-plugin-mcp-error" />;
  }
  if (query.isLoading || !form) {
    return <EmptyMessage text={L.plLoading} dataAttr="data-plugin-mcp-loading" />;
  }

  const { drafts } = form;
  const setDrafts = (next: McpServerDraft[]) => setForm({ ...form, drafts: next });
  const dirty = !sameMcpDrafts(draftsFromRead(query.data), drafts);
  const issues = mcpDraftIssues(drafts);
  const save = async () => {
    const saved = await props.actions.mcpWrite({
      pluginId: props.plugin.id, servers: drafts.map(toInput), baseHash: form.baseHash,
    });
    if (saved) setForm(formFromRead(saved));
    await refresh();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {drafts.length === 0
        ? <EmptyMessage text={L.plMcpNoServers} dataAttr="data-plugin-mcp-empty" />
        : <SRowGroup>{drafts.map((draft) => (
          <ServerForm key={draft.id} draft={draft}
            onChange={(patch) => setDrafts(replaceDraft(drafts, draft.id, patch))}
            onRemove={() => setDrafts(drafts.filter((item) => item.id !== draft.id))} />
        ))}</SRowGroup>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <SButton tone="neutral" data-action="mcp-add"
          onClick={() => { setDrafts([...drafts, emptyDraft(`new${nextId}`)]); setNextId(nextId + 1); }}>
          {L.plMcpAdd}
        </SButton>
        <SButton tone="primary" data-action="mcp-save"
          disabled={props.actions.busy || !dirty || issues.length > 0}
          onClick={save}>
          {L.plSave}
        </SButton>
      </div>
    </div>
  );
}

export function PluginMcpTab(props: { plugin: UiPluginCatalogEntry; actions: PluginAuthoringActions }) {
  if (props.plugin.kind !== 'portable') {
    return <ConvertNotice pluginId={props.plugin.id} busy={props.actions.busy} actions={props.actions} />;
  }
  return <McpServerForms plugin={props.plugin} actions={props.actions} />;
}
