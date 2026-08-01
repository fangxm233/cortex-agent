// input:  settings DTOs, localized copy, shared UI primitives
// output: desktop platform, auth, profile, machine, template and MCP panels
// pos:    Presentational collection for non-runtime settings panels
// >>> If I am updated, update my header comment and CORTEX.md <<<

import type { CSSProperties } from 'react';
import type { ConfigSnapshot, ThreadTemplateEntry } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';
import { SCard, SCardHeader, MonoKV, Toggle } from './settings-ui';
import {
  indexEnv,
  envRow,
  hasAnyKey,
  SLACK_KEYS,
  FEISHU_KEYS,
  API_KEYS,
  DAEMON_KEYS,
} from './platform-env';

// The presentational settings panels without live writes (Budget, Hooks, Notifications and Advanced
// live in focused modules that own their mutations).
// Each renders the prototype's exact 1:1 structure with REAL config.get data substituted; every
// affordance with no backend op is an inert placeholder and every field the contract does not carry
// is shown honestly (— / a flagged structural note) — never a fabricated value. Raw inline styles
// per §8.3.

const MONO = "'IBM Plex Mono',monospace";

// A green/gray "configured" pill derived HONESTLY from env presence (the prototype's
// "connected · socket mode" is live runtime state the contract does not expose).
export function PresencePill({ present }: { present: boolean }) {
  const L = useVocab();
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 600,
        padding: '1px 6px',
        borderRadius: 999,
        background: present ? 'var(--proto-success-bg)' : 'var(--proto-gray)',
        color: present ? 'var(--proto-success)' : 'var(--proto-muted-2)',
      }}
    >
      {present ? L.stConfigured : L.stNotConfigured}
    </span>
  );
}

export function PlatformAvatar({ glyph }: { glyph: string }) {
  return (
    <span
      style={{
        width: 22,
        height: 22,
        borderRadius: 6,
        background: 'var(--proto-gray)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 9,
        fontWeight: 700,
        color: 'var(--proto-muted)',
        flex: 'none',
      }}
    >
      {glyph}
    </span>
  );
}

// Reconnect is a HIGH-PRIVILEGE action (it restarts a live platform gateway). It is never
// bare-executed from the browser: when a handler is wired, clicking QUEUES an approval request
// (approvals.request → PENDING_APPROVALS.md); with no handler it stays inert. See b983 triage.
function ReconnectAction({
  platform,
  onReconnect,
}: {
  platform: 'slack' | 'feishu';
  onReconnect?: (platform: 'slack' | 'feishu') => void;
}) {
  const L = useVocab();
  const active = !!onReconnect;
  return (
    <span
      onClick={active ? () => onReconnect!(platform) : undefined}
      role={active ? 'button' : undefined}
      data-reconnect={platform}
      title={
        active
          ? L.stReconnectApprovalTitle
          : L.stReconnectInertTitle
      }
      style={{
        marginLeft: 'auto',
        fontSize: 10.5,
        fontWeight: 600,
        color: active ? 'var(--proto-accent)' : 'var(--proto-faint)',
        cursor: active ? 'pointer' : 'not-allowed',
      }}
    >
      {L.stReconnect}
    </span>
  );
}

function PlatformEnvBlock({ index, keys }: { index: ReturnType<typeof indexEnv>; keys: string[] }) {
  return (
    <div style={{ font: `400 10px/2 ${MONO}`, color: 'var(--proto-muted)', marginTop: 5, paddingLeft: 31 }}>
      {keys.map((k) => {
        const r = envRow(index, k);
        return (
          <MonoKV
            key={k}
            k={k}
            valueColor={r.present ? undefined : 'var(--proto-faint)'}
            value={
              r.present ? (
                <>
                  {r.display} <span style={{ color: 'var(--proto-success)' }}>✓</span>
                </>
              ) : (
                '—'
              )
            }
          />
        );
      })}
    </div>
  );
}

export function PlatformPanel({
  snapshot,
  onReconnect,
  onOpenLogin,
}: {
  snapshot: ConfigSnapshot;
  onReconnect?: (platform: 'slack' | 'feishu') => void;
  onOpenLogin?: () => void;
}) {
  const L = useVocab();
  const idx = indexEnv(snapshot.env);
  const slackPresent = hasAnyKey(snapshot.env, 'SLACK_');
  const feishuPresent = hasAnyKey(snapshot.env, 'FEISHU_');
  const tuiPresent = idx['CORTEX_TUI']?.present === true;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1.2fr 1fr',
        gap: 12,
        marginTop: 12,
        alignItems: 'start',
        maxWidth: 980,
      }}
    >
      <SCard>
        <SCardHeader title={L.stMessagingPlatforms} right="CORTEX_PLATFORM" />
        <div style={{ padding: '11px 14px', borderBottom: '1px solid var(--proto-alt)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <PlatformAvatar glyph="S" />
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--proto-ink)' }}>Slack</span>
            <PresencePill present={slackPresent} />
            <ReconnectAction platform="slack" onReconnect={onReconnect} />
          </div>
          <PlatformEnvBlock index={idx} keys={SLACK_KEYS} />
        </div>
        <div style={{ padding: '11px 14px', borderBottom: '1px solid var(--proto-alt)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <PlatformAvatar glyph="飞" />
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--proto-ink)' }}>飞书</span>
            <PresencePill present={feishuPresent} />
            <ReconnectAction platform="feishu" onReconnect={onReconnect} />
          </div>
          <PlatformEnvBlock index={idx} keys={FEISHU_KEYS} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px' }}>
          <Toggle on={tuiPresent} inert />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--proto-ink)' }}>{L.stTuiGateway}</div>
            <div style={{ fontSize: 10.5, color: 'var(--proto-muted-2)', marginTop: 1 }}>
              {L.tuiDesc}
            </div>
          </div>
          <span style={{ font: `400 9px ${MONO}`, color: 'var(--proto-faint)', flex: 'none' }}>CORTEX_TUI</span>
        </div>
      </SCard>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <SCard>
          <SCardHeader title={L.stApi} />
          <div style={{ padding: '8px 14px', font: `400 10px/2.1 ${MONO}`, color: 'var(--proto-muted)' }}>
            {API_KEYS.map((k) => {
              const r = envRow(idx, k);
              return (
                <MonoKV
                  key={k}
                  k={k}
                  valueColor={r.present ? undefined : 'var(--proto-faint)'}
                  value={
                    r.present ? (
                      <>
                        {r.display} <span style={{ color: 'var(--proto-success)' }}>✓</span>
                      </>
                    ) : (
                      '—'
                    )
                  }
                />
              );
            })}
          </div>
          <button
            type="button"
            data-auth-login-entry="desktop"
            disabled={!onOpenLogin}
            onClick={onOpenLogin}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%',
              border: 0, borderTop: '1px solid var(--proto-line-2)', padding: '9px 14px',
              background: 'transparent', textAlign: 'left', font: 'inherit',
              cursor: onOpenLogin ? 'pointer' : 'default',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--proto-ink)' }}>{L.authLoginEntry}</div>
              <div style={{ fontSize: 9.5, color: 'var(--proto-muted-2)', marginTop: 1 }}>{L.authLoginEntrySub}</div>
            </div>
            <span style={{ marginLeft: 'auto', color: 'var(--proto-accent)', fontSize: 11 }}>{L.open}</span>
          </button>
        </SCard>
        <SCard>
          <SCardHeader title={L.stDaemonNetwork} />
          <div style={{ padding: '8px 14px', font: `400 10px/2.1 ${MONO}`, color: 'var(--proto-muted)' }}>
            {DAEMON_KEYS.map((k) => {
              const r = envRow(idx, k);
              return (
                <MonoKV
                  key={k}
                  k={k}
                  valueColor={r.present ? 'var(--proto-ink)' : 'var(--proto-faint)'}
                  value={r.present ? r.display : '—'}
                />
              );
            })}
          </div>
        </SCard>
      </div>
    </div>
  );
}

const TH: CSSProperties = {
  fontSize: 9.5,
  fontWeight: 700,
  letterSpacing: '.05em',
  color: 'var(--proto-muted-3)',
};

export function ProfilesPanel({
  snapshot,
  onSetDefaultProfile,
}: {
  snapshot: ConfigSnapshot;
  onSetDefaultProfile?: (name: string) => void;
}) {
  const L = useVocab();
  const p = snapshot.profiles;
  const rows = p?.profiles ?? [];
  const grid = '84px 1fr 74px 52px 64px';
  // The default-profile picker is a REAL write when wired (config.set 'profiles' → re-points
  // profiles.json defaultProfile, read at each agent start). It can only SELECT an existing profile
  // (the option list is the real profiles.json rows), so it can never break startup. Inert when no
  // handler is passed (e.g. the pure render test).
  const canWrite = !!onSetDefaultProfile && rows.length > 0;
  return (
    <>
      <SCard
        style={{
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontSize: 11, color: 'var(--proto-muted)' }}>{L.stDefaultProfile}</span>
        {canWrite ? (
          <select
            data-default-profile-select
            value={p?.defaultProfile ?? ''}
            onChange={(e) => onSetDefaultProfile!(e.target.value)}
            style={{
              font: `600 11px ${MONO}`,
              color: 'var(--proto-ink)',
              border: '1px solid var(--proto-line)',
              borderRadius: 7,
              padding: '4px 10px',
              background: 'var(--proto-card)',
              cursor: 'pointer',
            }}
          >
            {rows.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
              </option>
            ))}
          </select>
        ) : (
          <span
            title="Select a profile to write profiles.json defaultProfile"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              border: '1px solid var(--proto-line)',
              borderRadius: 7,
              padding: '4px 10px',
            }}
          >
            <span style={{ font: `600 11px ${MONO}`, color: 'var(--proto-ink)' }}>{p?.defaultProfile ?? '—'}</span>
            <span style={{ color: 'var(--proto-muted-3)', fontSize: 8 }}>▾</span>
          </span>
        )}
        <span style={{ marginLeft: 'auto', font: `400 9.5px ${MONO}`, color: 'var(--proto-faint)' }}>
          {L.stProfReadNote}
        </span>
      </SCard>
      <SCard style={{ marginTop: 12, overflow: 'hidden' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: grid,
            padding: '7px 14px',
            borderBottom: '1px solid var(--proto-line-soft)',
            ...TH,
          }}
        >
          <span>{L.stColName}</span>
          <span>{L.stColModel}</span>
          <span>{L.stColBackend}</span>
          <span>{L.stColMode}</span>
          <span>{L.stColThinking}</span>
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: '12px 14px', fontSize: 11, color: 'var(--proto-muted-3)' }}>
            {L.stNoProfiles}
          </div>
        ) : (
          rows.map((r, i) => (
            <div
              key={r.name}
              style={{
                display: 'grid',
                gridTemplateColumns: grid,
                padding: '9px 14px',
                borderBottom: i < rows.length - 1 ? '1px solid var(--proto-alt)' : undefined,
                alignItems: 'center',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ font: `600 10.5px ${MONO}`, color: 'var(--proto-ink-2)' }}>{r.name}</span>
                {r.name === p?.defaultProfile ? (
                  <span
                    style={{
                      fontSize: 8,
                      fontWeight: 600,
                      padding: '1px 4px',
                      borderRadius: 999,
                      background: 'var(--proto-accent-bg)',
                      color: 'var(--proto-accent)',
                    }}
                  >
                    {L.default}
                  </span>
                ) : null}
              </span>
              <span
                style={{
                  font: `400 10px ${MONO}`,
                  color: 'var(--proto-muted)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  paddingRight: 8,
                }}
              >
                {r.model ?? '—'}
              </span>
              <span style={{ font: `400 10px ${MONO}`, color: 'var(--proto-muted)', whiteSpace: 'nowrap' }}>
                {r.backend ?? '—'}
              </span>
              <span style={{ font: `400 10px ${MONO}`, color: r.mode ? 'var(--proto-ink)' : 'var(--proto-faint)' }}>
                {r.mode ?? '—'}
              </span>
              <span style={{ font: `400 10px ${MONO}`, color: r.thinking ? 'var(--proto-ink)' : 'var(--proto-faint)' }}>
                {r.thinking ?? '—'}
              </span>
            </div>
          ))
        )}
      </SCard>
      <SCard style={{ marginTop: 12, padding: '10px 14px' }}>
        <div style={{ fontSize: 10.5, color: 'var(--proto-muted-2)' }}>
          {L.stProfFallbackNote}
        </div>
      </SCard>
    </>
  );
}

export function MachinesPanel({
  snapshot,
  onAddMachine,
}: {
  snapshot: ConfigSnapshot;
  onAddMachine?: (machineName: string) => void;
}) {
  const L = useVocab();
  const machines = snapshot.machines;
  const grid = '110px 1fr 44px 120px 90px 96px';
  const canAdd = !!onAddMachine;
  return (
    <div style={{ marginTop: 12, maxWidth: 980 }}>
      <SCard style={{ overflow: 'hidden' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: grid,
            padding: '7px 14px',
            borderBottom: '1px solid var(--proto-line-soft)',
            ...TH,
          }}
        >
          <span>{L.stColName}</span>
          <span>{L.stColCortexPath}</span>
          <span>{L.mGpu}</span>
          <span>{L.stColSsh}</span>
          <span>{L.stColOs}</span>
          <span></span>
        </div>
        {machines.length === 0 ? (
          <div style={{ padding: '12px 14px', fontSize: 11, color: 'var(--proto-muted-3)' }}>
            {L.stNoMachinesFile}
          </div>
        ) : (
          machines.map((m) => (
            <div
              key={m.name}
              style={{
                display: 'grid',
                gridTemplateColumns: grid,
                padding: '9px 14px',
                borderBottom: '1px solid var(--proto-alt)',
                alignItems: 'center',
              }}
            >
              <span style={{ font: `600 10.5px ${MONO}`, color: 'var(--proto-ink)' }}>{m.name}</span>
              <span
                style={{
                  font: `400 9.5px ${MONO}`,
                  color: 'var(--proto-muted)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  paddingRight: 8,
                }}
              >
                {m.cortexPath ?? '—'}
              </span>
              <span style={{ font: `400 10px ${MONO}`, color: 'var(--proto-ink-2)' }}>{m.gpuCount ?? '—'}</span>
              <span style={{ font: `400 9.5px ${MONO}`, color: m.ssh ? 'var(--proto-muted)' : 'var(--proto-faint)' }}>
                {m.ssh ? L.stConfigured : L.stMachineLocal}
              </span>
              <span style={{ font: `400 9.5px ${MONO}`, color: 'var(--proto-muted)' }}>
                {m.win ? L.stWinOs : L.stUnixOs}
              </span>
              <span
                title="No machine logs/registry backend op — inert"
                style={{ fontSize: 10, fontWeight: 600, color: 'var(--proto-faint)', textAlign: 'right', cursor: 'not-allowed' }}
              >
                {L.stLogs}
              </span>
            </div>
          ))
        )}
        {/* Add machine is HIGH-PRIVILEGE (registers a new remote client). It never writes
            machines.json from the browser: when wired it QUEUES an approval request
            (approvals.request) with the entered name; a human/agent completes the registration
            after approval. Inert with no handler. See b983 triage. */}
        <div
          onClick={
            canAdd
              ? () => {
                  const name = window.prompt(L.stAddMachinePrompt);
                  const trimmed = name?.trim();
                  if (trimmed) onAddMachine!(trimmed);
                }
              : undefined
          }
          role={canAdd ? 'button' : undefined}
          data-add-machine={canAdd ? '' : undefined}
          title={
            canAdd
              ? L.stAddMachineApprovalTitle
              : L.stAddMachineInertTitle
          }
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            padding: '9px 14px',
            cursor: canAdd ? 'pointer' : 'not-allowed',
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 600, color: canAdd ? 'var(--proto-accent)' : 'var(--proto-faint)' }}>
            {L.stAddMachine}
          </span>
          <span style={{ font: `400 9px ${MONO}`, color: 'var(--proto-faint)' }}>
            {L.stMachineFieldsHint}
          </span>
        </div>
      </SCard>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 12,
          marginTop: 12,
          alignItems: 'start',
        }}
      >
        <SCard>
          <SCardHeader title={L.stClientLifecycle} right="client-manager" />
          <div style={{ padding: '8px 14px', fontSize: 10.5, lineHeight: 2, color: 'var(--proto-muted)' }}>
            <MonoInfoRow k={L.mHeartbeat} v="5s · 15s timeout" />
            <MonoInfoRow k={L.mRecover} v="SSH restart · 60s backoff" />
            <MonoInfoRow k="PID" v="data/client-pids.json" />
            <MonoInfoRow k="WebSocket" v=":3002 · CORTEX_CLIENT_TOKEN" />
          </div>
        </SCard>
        <SCard>
          <SCardHeader title={L.stConnectivity} right="cortex-client.json" />
          <div style={{ padding: '8px 14px', fontSize: 10.5, lineHeight: 2, color: 'var(--proto-muted)' }}>
            <MonoInfoRow k="LAN" v="serverHost = LAN IP" />
            <MonoInfoRow k="Tailscale" v="100.x.y.z" />
            <MonoInfoRow k="CF Tunnel" v="serverUrl = wss://…" />
            <MonoInfoRow k={L.mFirewall} v="STCP" />
          </div>
        </SCard>
      </div>
      <SCard style={{ marginTop: 12, padding: '10px 14px' }}>
        <div style={{ fontSize: 10.5, color: 'var(--proto-muted-2)' }}>
          {L.stMachinesFootNote}
        </div>
      </SCard>
    </div>
  );
}

function MonoInfoRow({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex' }}>
      <span>{k}</span>
      <span style={{ marginLeft: 'auto', font: `400 9.5px ${MONO}`, color: 'var(--proto-ink)' }}>{v}</span>
    </div>
  );
}

const KIND_STYLE: Record<ThreadTemplateEntry['kind'], { bg: string; color: string }> = {
  template: { bg: 'var(--proto-accent-bg)', color: 'var(--proto-accent)' },
  agent: { bg: 'var(--proto-success-bg)', color: 'var(--proto-success)' },
  shell: { bg: 'var(--proto-amber-bg)', color: 'var(--proto-amber)' },
};

function KindBadge({ kind }: { kind: ThreadTemplateEntry['kind'] }) {
  const s = KIND_STYLE[kind];
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 700,
        padding: '1px 6px',
        borderRadius: 999,
        background: s.bg,
        color: s.color,
        flex: 'none',
        letterSpacing: '.02em',
      }}
    >
      {kind}
    </span>
  );
}

// TemplatesPanel renders basenames from snapshot.threadTemplates when no entries are provided
// (backward-compat / loading state). When entries are provided (threadTemplates.get data), it
// renders real template content: kind badge, name, description, body key count.
export function TemplatesPanel({
  snapshot,
  entries,
}: {
  snapshot: ConfigSnapshot;
  entries?: ThreadTemplateEntry[];
}) {
  const L = useVocab();
  if (entries) {
    const grid = '76px 140px 1fr 52px';
    return (
      <SCard style={{ marginTop: 12, maxWidth: 860, overflow: 'hidden' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '11px 14px',
            borderBottom: '1px solid var(--proto-line-2)',
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 650, color: 'var(--proto-ink)' }}>{L.tplList}</span>
          <span
            style={{ marginLeft: 10, font: `400 9.5px ${MONO}`, color: 'var(--proto-faint)' }}
          >
            {entries.length} {entries.length === 1 ? L.stEntry : L.stEntries}
          </span>
          <span
            title={L.stTemplateEditorInertTitle}
            style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600, color: 'var(--proto-faint)', cursor: 'not-allowed' }}
          >
            {L.stOpenEditor}
          </span>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: grid,
            padding: '6px 14px',
            borderBottom: '1px solid var(--proto-line-soft)',
            ...TH,
          }}
        >
          <span>{L.stColKind}</span>
          <span>{L.stColName}</span>
          <span>{L.stColDescription}</span>
          <span style={{ textAlign: 'right' }}>{L.stColKeys}</span>
        </div>
        {entries.length === 0 ? (
          <div style={{ padding: '12px 14px', fontSize: 11, color: 'var(--proto-muted-3)' }}>
            {L.stNoTemplates}
          </div>
        ) : (
          entries.map((e, i) => {
            const keyCount = e.body ? Object.keys(e.body).length : null;
            return (
              <div
                key={`${e.kind}:${e.name}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: grid,
                  padding: '8px 14px',
                  borderBottom: i < entries.length - 1 ? '1px solid var(--proto-alt)' : undefined,
                  alignItems: 'center',
                }}
              >
                <KindBadge kind={e.kind} />
                <span style={{ font: `600 10.5px ${MONO}`, color: 'var(--proto-ink-2)' }}>{e.name}</span>
                <span
                  style={{
                    fontSize: 10.5,
                    color: e.description ? 'var(--proto-muted)' : 'var(--proto-faint)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    paddingRight: 8,
                  }}
                >
                  {e.description ?? '—'}
                </span>
                <span
                  style={{
                    font: `400 10px ${MONO}`,
                    color: keyCount != null ? 'var(--proto-muted)' : 'var(--proto-faint)',
                    textAlign: 'right',
                  }}
                >
                  {keyCount != null ? keyCount : '—'}
                </span>
              </div>
            );
          })
        )}
        <div style={{ borderTop: '1px solid var(--proto-line-2)', padding: '8px 14px', fontSize: 10, color: 'var(--proto-faint)' }}>
          {L.stTemplatesFootNote1}
        </div>
      </SCard>
    );
  }

  // Fallback: basename list from config.get snapshot (no entries loaded yet)
  const tt = snapshot.threadTemplates;
  const groups: { label: string; items: string[] }[] = [
    { label: L.stGrpTemplates, items: tt.templates },
    { label: L.stGrpAgents, items: tt.agents },
    { label: L.stGrpShells, items: tt.shells },
  ];
  return (
    <SCard style={{ marginTop: 12, maxWidth: 760 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '11px 14px',
          borderBottom: '1px solid var(--proto-line-2)',
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 650, color: 'var(--proto-ink)' }}>{L.tplList}</span>
        <span
          title={L.stTemplateEditorInertTitle}
          style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600, color: 'var(--proto-faint)', cursor: 'not-allowed' }}
        >
          {L.stOpenEditor}
        </span>
      </div>
      {groups.map((g) => (
        <div key={g.label} style={{ borderBottom: '1px solid var(--proto-alt)', padding: '8px 14px 10px' }}>
          <div style={{ ...TH, marginBottom: 6 }}>{g.label.toUpperCase()}</div>
          {g.items.length === 0 ? (
            <div style={{ fontSize: 10.5, color: 'var(--proto-faint)' }}>{L.stNone}</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {g.items.map((name) => (
                <span
                  key={name}
                  style={{
                    font: `500 10px ${MONO}`,
                    color: 'var(--proto-muted)',
                    background: 'var(--proto-alt)',
                    border: '1px solid var(--proto-line-2)',
                    padding: '2px 8px',
                    borderRadius: 6,
                  }}
                >
                  {name}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
      <div style={{ padding: '9px 14px', fontSize: 10, color: 'var(--proto-faint)' }}>
        {L.stTemplatesFootNote2}
      </div>
    </SCard>
  );
}

export function McpPanel({ snapshot }: { snapshot: ConfigSnapshot }) {
  const L = useVocab();
  const servers = snapshot.mcp?.servers ?? [];
  return (
    <SCard style={{ marginTop: 12, maxWidth: 760 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '11px 14px',
          borderBottom: '1px solid var(--proto-line-2)',
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 650, color: 'var(--proto-ink)' }}>{L.stServers}</span>
        <div
          title="full / core / tui variant is a runtime-mode selection — no config.set for it (inert)"
          style={{ marginLeft: 'auto', display: 'flex', background: 'var(--proto-line-2)', borderRadius: 7, padding: 2 }}
        >
          {['full', 'core', 'tui'].map((v) => (
            <span
              key={v}
              style={{
                font: `500 10px ${MONO}`,
                color: v === 'full' ? 'var(--proto-ink)' : 'var(--proto-muted-2)',
                background: v === 'full' ? 'var(--proto-card)' : 'transparent',
                borderRadius: 5,
                padding: '3px 10px',
                boxShadow: v === 'full' ? '0 1px 2px rgba(16,24,40,.06)' : 'none',
                cursor: 'not-allowed',
              }}
            >
              {v}
            </span>
          ))}
        </div>
      </div>
      {servers.length === 0 ? (
        <div style={{ padding: '12px 14px', fontSize: 11, color: 'var(--proto-muted-3)' }}>
          {L.stNoServers}
        </div>
      ) : (
        servers.map((name, i) => (
          <div
            key={name}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 14px',
              borderBottom: i < servers.length - 1 ? '1px solid var(--proto-alt)' : undefined,
            }}
          >
            <span style={{ font: `600 11.5px ${MONO}`, color: 'var(--proto-ink)' }}>{name}</span>
          </div>
        ))
      )}
      <div style={{ borderTop: '1px solid var(--proto-line-2)', padding: '8px 14px', fontSize: 10, color: 'var(--proto-faint)' }}>
        {L.stMcpFootNote}
      </div>
    </SCard>
  );
}
