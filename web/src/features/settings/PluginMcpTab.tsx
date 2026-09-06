// input:  one plugin's redacted MCP servers and the authoring actions
// output: the MCP tab — server forms with write-only secrets, plus the portable conversion
// pos:    MCP management inside the plugin package manager
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useEffect, useState, type CSSProperties } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PluginsMcpRead, UiPluginCatalogEntry } from '@cortex-agent/ui-contract';
import { Select } from '@/design';
import { useVocab, type Vocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { SButton, SFieldRow, S_CONTROL_STYLE } from './settings-ui';
import { EmptyMessage, NOTICE, ROW } from './plugin-ui';
import {
  draftsFromRead, emptyDraft, mcpDraftIssues, replaceDraft, sameMcpDrafts, toInput,
  type McpSecretRow, type McpServerDraft, type McpTransport,
} from './plugin-authoring-vm';
import type { PluginAuthoringActions } from './usePluginAuthoring';

const MONO = "'IBM Plex Mono',monospace";
const SECRET_ROW: CSSProperties = { display: 'flex', gap: 6, alignItems: 'center' };

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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {props.draft.secrets.map((row, index) => (
          <div key={`${props.draft.id}:${index}`} data-plugin-secret={row.key} style={SECRET_ROW}>
            <input data-field="secret-key" value={row.key} placeholder={L.plMcpKeyPh}
              onChange={(event) => update(index, { key: event.target.value })}
              style={{ ...S_CONTROL_STYLE, width: 150 }} />
            {row.value === null
              ? (
                <>
                  <span style={{ font: `400 10px ${MONO}`, color: 'var(--proto-faint)', flex: 1 }}>{L.plMcpSecretKept}</span>
                  <SButton tone="neutral" data-action="secret-replace" onClick={() => update(index, { value: '' })}>
                    {L.plMcpSecretReplace}
                  </SButton>
                </>
              )
              : (
                <input data-field="secret-value" value={row.value} placeholder={L.plMcpSecretPh}
                  onChange={(event) => update(index, { value: event.target.value })}
                  style={{ ...S_CONTROL_STYLE, flex: 1 }} />
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
    <div data-plugin-mcp-server={props.draft.id} style={{ ...ROW, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <SFieldRow label={L.plMcpName}>
        <input data-field="mcp-name" value={props.draft.name}
          onChange={(event) => props.onChange({ name: event.target.value })} style={S_CONTROL_STYLE} />
      </SFieldRow>
      <SFieldRow label={L.plMcpTransport}>
        <Select value={props.draft.type} options={transportOptions(L)}
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
      <div style={{ display: 'flex' }}>
        <SButton tone="danger" data-action="mcp-remove-server" onClick={props.onRemove}>{L.plMcpRemove}</SButton>
      </div>
    </div>
  );
}

function ConvertNotice(props: { pluginId: string; busy: boolean; actions: PluginAuthoringActions }) {
  const L = useVocab();
  return (
    <div data-plugin-mcp-unsupported="" style={{ ...NOTICE, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div>{L.plMcpLegacyNote}</div>
      <div>{L.plConvertNote}</div>
      <div style={{ display: 'flex' }}>
        <SButton tone="accent" data-action="mcp-convert" disabled={props.busy}
          onClick={() => props.actions.convertToPortable({ id: props.pluginId })}>
          {L.plConvertPortable}
        </SButton>
      </div>
    </div>
  );
}

/** Split from {@link PluginMcpTab} so the legacy branch renders without a query client at all:
 *  hooks cannot be skipped, and a legacy plugin has no mcp.json worth reading. */
function McpServerForms(props: { plugin: UiPluginCatalogEntry; actions: PluginAuthoringActions }) {
  const L = useVocab();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const query = useQuery<PluginsMcpRead>(
    trpc.plugins.mcpRead.queryOptions({ pluginId: props.plugin.id }) as never,
  );
  const [drafts, setDrafts] = useState<McpServerDraft[] | null>(null);
  const [nextId, setNextId] = useState(0);

  // Re-baseline whenever a fresh read lands for a different plugin, or after a save changed it.
  useEffect(() => {
    setDrafts(null);
  }, [props.plugin.id]);
  useEffect(() => {
    if (query.data) setDrafts((current) => current ?? draftsFromRead(query.data));
  }, [query.data]);

  if (query.isLoading || !drafts) {
    return <EmptyMessage text={L.plLoading} dataAttr="data-plugin-mcp-loading" />;
  }
  if (query.isError) {
    return <EmptyMessage text={`${L.plMcpSaveFailed} ${errorMessage(query.error)}`} dataAttr="data-plugin-mcp-error" />;
  }

  const baseline = draftsFromRead(query.data);
  const dirty = !sameMcpDrafts(baseline, drafts);
  const issues = mcpDraftIssues(drafts);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {drafts.length === 0
        ? <EmptyMessage text={L.plMcpNoServers} dataAttr="data-plugin-mcp-empty" />
        : drafts.map((draft) => (
          <ServerForm key={draft.id} draft={draft}
            onChange={(patch) => setDrafts(replaceDraft(drafts, draft.id, patch))}
            onRemove={() => setDrafts(drafts.filter((item) => item.id !== draft.id))} />
        ))}
      <div style={{ display: 'flex', gap: 6 }}>
        <SButton tone="neutral" data-action="mcp-add"
          onClick={() => { setDrafts([...drafts, emptyDraft(`new${nextId}`)]); setNextId(nextId + 1); }}>
          {L.plMcpAdd}
        </SButton>
        <SButton tone="accent" data-action="mcp-save"
          disabled={props.actions.busy || !dirty || issues.length > 0}
          onClick={async () => {
            const done = await props.actions.mcpWrite({
              pluginId: props.plugin.id, servers: drafts.map(toInput),
            });
            if (!done) return;
            // The write is only visible to this tab once its own read is refetched — the shared
            // action controller refreshes the catalog list, not every per-plugin query.
            await queryClient.invalidateQueries(trpc.plugins.mcpRead.queryFilter({ pluginId: props.plugin.id }));
            setDrafts(null);
          }}>
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
