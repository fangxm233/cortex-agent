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
  NOTIFY_KEYS,
  ADVANCED_FLAGS,
} from './platform-env';

// The 8 presentational settings panels (Budget lives in BudgetPanel.tsx — it owns the live write).
// Each renders the prototype's exact 1:1 structure with REAL config.get data substituted; every
// affordance with no backend op is an inert placeholder and every field the contract does not carry
// is shown honestly (— / a flagged structural note) — never a fabricated value. Raw inline styles
// per §8.3.

const MONO = "'IBM Plex Mono',monospace";

// A green/gray "configured" pill derived HONESTLY from env presence (the prototype's
// "connected · socket mode" is live runtime state the contract does not expose).
function PresencePill({ present }: { present: boolean }) {
  const L = useVocab();
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 600,
        padding: '1px 6px',
        borderRadius: 999,
        background: present ? '#E9F4EE' : '#F1F2F5',
        color: present ? '#23854F' : '#8A93A2',
      }}
    >
      {present ? L.stConfigured : L.stNotConfigured}
    </span>
  );
}

function PlatformAvatar({ glyph }: { glyph: string }) {
  return (
    <span
      style={{
        width: 22,
        height: 22,
        borderRadius: 6,
        background: '#F1F2F5',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 9,
        fontWeight: 700,
        color: '#5B6472',
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
        color: active ? '#4655D4' : '#B6BDC9',
        cursor: active ? 'pointer' : 'not-allowed',
      }}
    >
      {L.stReconnect}
    </span>
  );
}

function PlatformEnvBlock({ index, keys }: { index: ReturnType<typeof indexEnv>; keys: string[] }) {
  return (
    <div style={{ font: `400 10px/2 ${MONO}`, color: '#5B6472', marginTop: 5, paddingLeft: 31 }}>
      {keys.map((k) => {
        const r = envRow(index, k);
        return (
          <MonoKV
            key={k}
            k={k}
            valueColor={r.present ? undefined : '#B6BDC9'}
            value={
              r.present ? (
                <>
                  {r.display} <span style={{ color: '#23854F' }}>✓</span>
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
}: {
  snapshot: ConfigSnapshot;
  onReconnect?: (platform: 'slack' | 'feishu') => void;
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
        <div style={{ padding: '11px 14px', borderBottom: '1px solid #F7F8FA' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <PlatformAvatar glyph="S" />
            <span style={{ fontSize: 12, fontWeight: 600, color: '#191C22' }}>Slack</span>
            <PresencePill present={slackPresent} />
            <ReconnectAction platform="slack" onReconnect={onReconnect} />
          </div>
          <PlatformEnvBlock index={idx} keys={SLACK_KEYS} />
        </div>
        <div style={{ padding: '11px 14px', borderBottom: '1px solid #F7F8FA' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <PlatformAvatar glyph="飞" />
            <span style={{ fontSize: 12, fontWeight: 600, color: '#191C22' }}>飞书</span>
            <PresencePill present={feishuPresent} />
            <ReconnectAction platform="feishu" onReconnect={onReconnect} />
          </div>
          <PlatformEnvBlock index={idx} keys={FEISHU_KEYS} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px' }}>
          <Toggle on={tuiPresent} inert />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#191C22' }}>{L.stTuiGateway}</div>
            <div style={{ fontSize: 10.5, color: '#8A93A2', marginTop: 1 }}>
              {L.tuiDesc}
            </div>
          </div>
          <span style={{ font: `400 9px ${MONO}`, color: '#B6BDC9', flex: 'none' }}>CORTEX_TUI</span>
        </div>
      </SCard>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <SCard>
          <SCardHeader title={L.stApi} />
          <div style={{ padding: '8px 14px', font: `400 10px/2.1 ${MONO}`, color: '#5B6472' }}>
            {API_KEYS.map((k) => {
              const r = envRow(idx, k);
              return (
                <MonoKV
                  key={k}
                  k={k}
                  valueColor={r.present ? undefined : '#B6BDC9'}
                  value={
                    r.present ? (
                      <>
                        {r.display} <span style={{ color: '#23854F' }}>✓</span>
                      </>
                    ) : (
                      '—'
                    )
                  }
                />
              );
            })}
          </div>
        </SCard>
        <SCard>
          <SCardHeader title={L.stDaemonNetwork} />
          <div style={{ padding: '8px 14px', font: `400 10px/2.1 ${MONO}`, color: '#5B6472' }}>
            {DAEMON_KEYS.map((k) => {
              const r = envRow(idx, k);
              return (
                <MonoKV
                  key={k}
                  k={k}
                  valueColor={r.present ? '#191C22' : '#B6BDC9'}
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
  color: '#98A1B0',
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
  const grid = '84px 1fr 74px 52px';
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
        <span style={{ fontSize: 11, color: '#5B6472' }}>{L.stDefaultProfile}</span>
        {canWrite ? (
          <select
            data-default-profile-select
            value={p?.defaultProfile ?? ''}
            onChange={(e) => onSetDefaultProfile!(e.target.value)}
            style={{
              font: `600 11px ${MONO}`,
              color: '#191C22',
              border: '1px solid #E7E9EE',
              borderRadius: 7,
              padding: '4px 10px',
              background: '#fff',
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
              border: '1px solid #E7E9EE',
              borderRadius: 7,
              padding: '4px 10px',
            }}
          >
            <span style={{ font: `600 11px ${MONO}`, color: '#191C22' }}>{p?.defaultProfile ?? '—'}</span>
            <span style={{ color: '#98A1B0', fontSize: 8 }}>▾</span>
          </span>
        )}
        <span style={{ marginLeft: 'auto', font: `400 9.5px ${MONO}`, color: '#B6BDC9' }}>
          {L.stProfReadNote}
        </span>
      </SCard>
      <SCard style={{ marginTop: 12, overflow: 'hidden' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: grid,
            padding: '7px 14px',
            borderBottom: '1px solid #F3F4F7',
            ...TH,
          }}
        >
          <span>{L.stColName}</span>
          <span>{L.stColModel}</span>
          <span>{L.stColBackend}</span>
          <span>{L.stColMode}</span>
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: '12px 14px', fontSize: 11, color: '#98A1B0' }}>
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
                borderBottom: i < rows.length - 1 ? '1px solid #F7F8FA' : undefined,
                alignItems: 'center',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ font: `600 10.5px ${MONO}`, color: '#22262E' }}>{r.name}</span>
                {r.name === p?.defaultProfile ? (
                  <span
                    style={{
                      fontSize: 8,
                      fontWeight: 600,
                      padding: '1px 4px',
                      borderRadius: 999,
                      background: '#EEF0FA',
                      color: '#4655D4',
                    }}
                  >
                    {L.default}
                  </span>
                ) : null}
              </span>
              <span
                style={{
                  font: `400 10px ${MONO}`,
                  color: '#5B6472',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  paddingRight: 8,
                }}
              >
                {r.model ?? '—'}
              </span>
              <span style={{ font: `400 10px ${MONO}`, color: '#5B6472', whiteSpace: 'nowrap' }}>
                {r.backend ?? '—'}
              </span>
              <span style={{ font: `400 10px ${MONO}`, color: r.mode ? '#191C22' : '#B6BDC9' }}>
                {r.mode ?? '—'}
              </span>
            </div>
          ))
        )}
      </SCard>
      <SCard style={{ marginTop: 12, padding: '10px 14px' }}>
        <div style={{ fontSize: 10.5, color: '#8A93A2' }}>
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
            borderBottom: '1px solid #F3F4F7',
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
          <div style={{ padding: '12px 14px', fontSize: 11, color: '#98A1B0' }}>
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
                borderBottom: '1px solid #F7F8FA',
                alignItems: 'center',
              }}
            >
              <span style={{ font: `600 10.5px ${MONO}`, color: '#191C22' }}>{m.name}</span>
              <span
                style={{
                  font: `400 9.5px ${MONO}`,
                  color: '#5B6472',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  paddingRight: 8,
                }}
              >
                {m.cortexPath ?? '—'}
              </span>
              <span style={{ font: `400 10px ${MONO}`, color: '#22262E' }}>{m.gpuCount ?? '—'}</span>
              <span style={{ font: `400 9.5px ${MONO}`, color: m.ssh ? '#5B6472' : '#B6BDC9' }}>
                {m.ssh ? L.stConfigured : L.stMachineLocal}
              </span>
              <span style={{ font: `400 9.5px ${MONO}`, color: '#5B6472' }}>
                {m.win ? L.stWinOs : L.stUnixOs}
              </span>
              <span
                title="No machine logs/registry backend op — inert"
                style={{ fontSize: 10, fontWeight: 600, color: '#B6BDC9', textAlign: 'right', cursor: 'not-allowed' }}
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
          <span style={{ fontSize: 11, fontWeight: 600, color: canAdd ? '#4655D4' : '#B6BDC9' }}>
            {L.stAddMachine}
          </span>
          <span style={{ font: `400 9px ${MONO}`, color: '#B6BDC9' }}>
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
          <div style={{ padding: '8px 14px', fontSize: 10.5, lineHeight: 2, color: '#5B6472' }}>
            <MonoInfoRow k={L.mHeartbeat} v="5s · 15s timeout" />
            <MonoInfoRow k={L.mRecover} v="SSH restart · 60s backoff" />
            <MonoInfoRow k="PID" v="data/client-pids.json" />
            <MonoInfoRow k="WebSocket" v=":3002 · CORTEX_CLIENT_TOKEN" />
          </div>
        </SCard>
        <SCard>
          <SCardHeader title={L.stConnectivity} right="cortex-client.json" />
          <div style={{ padding: '8px 14px', fontSize: 10.5, lineHeight: 2, color: '#5B6472' }}>
            <MonoInfoRow k="LAN" v="serverHost = LAN IP" />
            <MonoInfoRow k="Tailscale" v="100.x.y.z" />
            <MonoInfoRow k="CF Tunnel" v="serverUrl = wss://…" />
            <MonoInfoRow k={L.mFirewall} v="STCP" />
          </div>
        </SCard>
      </div>
      <SCard style={{ marginTop: 12, padding: '10px 14px' }}>
        <div style={{ fontSize: 10.5, color: '#8A93A2' }}>
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
      <span style={{ marginLeft: 'auto', font: `400 9.5px ${MONO}`, color: '#191C22' }}>{v}</span>
    </div>
  );
}

const KIND_STYLE: Record<ThreadTemplateEntry['kind'], { bg: string; color: string }> = {
  template: { bg: '#EEF0FA', color: '#4655D4' },
  agent: { bg: '#E9F4EE', color: '#23854F' },
  shell: { bg: '#FDF9F0', color: '#8B6914' },
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
            borderBottom: '1px solid #EFF1F5',
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 650, color: '#191C22' }}>{L.tplList}</span>
          <span
            style={{ marginLeft: 10, font: `400 9.5px ${MONO}`, color: '#B6BDC9' }}
          >
            {entries.length} {entries.length === 1 ? L.stEntry : L.stEntries}
          </span>
          <span
            title={L.stTemplateEditorInertTitle}
            style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600, color: '#B6BDC9', cursor: 'not-allowed' }}
          >
            {L.stOpenEditor}
          </span>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: grid,
            padding: '6px 14px',
            borderBottom: '1px solid #F3F4F7',
            ...TH,
          }}
        >
          <span>{L.stColKind}</span>
          <span>{L.stColName}</span>
          <span>{L.stColDescription}</span>
          <span style={{ textAlign: 'right' }}>{L.stColKeys}</span>
        </div>
        {entries.length === 0 ? (
          <div style={{ padding: '12px 14px', fontSize: 11, color: '#98A1B0' }}>
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
                  borderBottom: i < entries.length - 1 ? '1px solid #F7F8FA' : undefined,
                  alignItems: 'center',
                }}
              >
                <KindBadge kind={e.kind} />
                <span style={{ font: `600 10.5px ${MONO}`, color: '#22262E' }}>{e.name}</span>
                <span
                  style={{
                    fontSize: 10.5,
                    color: e.description ? '#5B6472' : '#B6BDC9',
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
                    color: keyCount != null ? '#5B6472' : '#B6BDC9',
                    textAlign: 'right',
                  }}
                >
                  {keyCount != null ? keyCount : '—'}
                </span>
              </div>
            );
          })
        )}
        <div style={{ borderTop: '1px solid #EFF1F5', padding: '8px 14px', fontSize: 10, color: '#B6BDC9' }}>
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
          borderBottom: '1px solid #EFF1F5',
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 650, color: '#191C22' }}>{L.tplList}</span>
        <span
          title={L.stTemplateEditorInertTitle}
          style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600, color: '#B6BDC9', cursor: 'not-allowed' }}
        >
          {L.stOpenEditor}
        </span>
      </div>
      {groups.map((g) => (
        <div key={g.label} style={{ borderBottom: '1px solid #F7F8FA', padding: '8px 14px 10px' }}>
          <div style={{ ...TH, marginBottom: 6 }}>{g.label.toUpperCase()}</div>
          {g.items.length === 0 ? (
            <div style={{ fontSize: 10.5, color: '#B6BDC9' }}>{L.stNone}</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {g.items.map((name) => (
                <span
                  key={name}
                  style={{
                    font: `500 10px ${MONO}`,
                    color: '#5B6472',
                    background: '#F7F8FA',
                    border: '1px solid #EFF1F5',
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
      <div style={{ padding: '9px 14px', fontSize: 10, color: '#B6BDC9' }}>
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
          borderBottom: '1px solid #EFF1F5',
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 650, color: '#191C22' }}>{L.stServers}</span>
        <div
          title="full / core / tui variant is a runtime-mode selection — no config.set for it (inert)"
          style={{ marginLeft: 'auto', display: 'flex', background: '#EFF1F5', borderRadius: 7, padding: 2 }}
        >
          {['full', 'core', 'tui'].map((v) => (
            <span
              key={v}
              style={{
                font: `500 10px ${MONO}`,
                color: v === 'full' ? '#191C22' : '#8A93A2',
                background: v === 'full' ? '#fff' : 'transparent',
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
        <div style={{ padding: '12px 14px', fontSize: 11, color: '#98A1B0' }}>
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
              borderBottom: i < servers.length - 1 ? '1px solid #F7F8FA' : undefined,
            }}
          >
            <span style={{ font: `600 11.5px ${MONO}`, color: '#191C22' }}>{name}</span>
          </div>
        ))
      )}
      <div style={{ borderTop: '1px solid #EFF1F5', padding: '8px 14px', fontSize: 10, color: '#B6BDC9' }}>
        {L.stMcpFootNote}
      </div>
    </SCard>
  );
}

export function NotificationsPanel({ snapshot }: { snapshot: ConfigSnapshot }) {
  const L = useVocab();
  const idx = indexEnv(snapshot.env);
  const slackPresent = hasAnyKey(snapshot.env, 'SLACK_');
  const feishuPresent = hasAnyKey(snapshot.env, 'FEISHU_');
  // Specific admin-channel key presence for notification routing.
  // Values are always masked (••••••••) — never cleartext — enforced by config.get contract.
  const slackChannel = envRow(idx, 'SLACK_ADMIN_CHANNEL');
  const feishuChannel = envRow(idx, 'FEISHU_ADMIN_CHANNEL');
  const toggles: { key: string; title: string; desc: string; env: string }[] = [
    {
      key: NOTIFY_KEYS.turn,
      title: L.stNotifyTurnTitle,
      desc: L.stNotifyTurnDesc,
      env: 'CORTEX_TURN_NOTIFY',
    },
    {
      key: NOTIFY_KEYS.resume,
      title: L.stNotifyResumeTitle,
      desc: L.stNotifyResumeDesc,
      env: 'CORTEX_AUTO_RESUME',
    },
    {
      key: NOTIFY_KEYS.compaction,
      title: L.stNotifyCompactionTitle,
      desc: L.stNotifyCompactionDesc,
      env: 'CORTEX_NOTIFY_COMPACTION',
    },
  ];
  return (
    <>
      {/* Env-flag toggles — REAL presence from config.get.
          WRITE path (env toggle) belongs to settings-actions / M-B-9 — controls are inert here. */}
      <SCard>
        {toggles.map((t, i) => (
          <div
            key={t.env}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 13,
              padding: '11px 14px',
              borderBottom: i < toggles.length - 1 ? '1px solid #F7F8FA' : undefined,
            }}
          >
            <Toggle on={idx[t.key]?.present === true} inert />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#191C22' }}>{t.title}</div>
              <div style={{ fontSize: 10.5, color: '#8A93A2', marginTop: 1 }}>{t.desc}</div>
            </div>
            <span style={{ font: `400 9px ${MONO}`, color: '#B6BDC9', flex: 'none' }}>{t.env}</span>
          </div>
        ))}
      </SCard>

      {/* Platform routing — REAL data: shows SLACK_ADMIN_CHANNEL / FEISHU_ADMIN_CHANNEL key
          presence (masked ••••••••; value never returned by config.get contract). */}
      <SCard style={{ marginTop: 12 }}>
        <SCardHeader title={L.stNotifyRoutingTitle} right={L.stNotifyRoutingRight} />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 14px',
            borderBottom: '1px solid #F7F8FA',
          }}
        >
          <PlatformAvatar glyph="S" />
          <span style={{ fontSize: 11.5, fontWeight: 600, color: '#191C22' }}>Slack</span>
          <PresencePill present={slackPresent} />
          {slackPresent && (
            <span style={{ marginLeft: 'auto', font: `400 9.5px ${MONO}`, color: '#8A93A2' }}>
              {'SLACK_ADMIN_CHANNEL: '}
              <span style={{ color: slackChannel.present ? '#5B6472' : '#B6BDC9' }}>
                {slackChannel.display}
              </span>
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px' }}>
          <PlatformAvatar glyph="飞" />
          <span style={{ fontSize: 11.5, fontWeight: 600, color: '#191C22' }}>飞书</span>
          <PresencePill present={feishuPresent} />
          {feishuPresent && (
            <span style={{ marginLeft: 'auto', font: `400 9.5px ${MONO}`, color: '#8A93A2' }}>
              {'FEISHU_ADMIN_CHANNEL: '}
              <span style={{ color: feishuChannel.present ? '#5B6472' : '#B6BDC9' }}>
                {feishuChannel.display}
              </span>
            </span>
          )}
        </div>
      </SCard>

      {/* Approval reminder — fixed policy: always on */}
      <div
        style={{
          marginTop: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '9px 12px',
          background: '#FDF9F0',
          border: '1px solid #EFDDB0',
          borderRadius: 9,
          maxWidth: 760,
          boxSizing: 'border-box',
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#C99A2E', flex: 'none' }} />
        <span style={{ fontSize: 10.5, color: '#6B5A1E' }}>
          {L.stApprovalReminderNote}
        </span>
      </div>

      {/* Recent notifications — honest placeholder (zero-source).
          Investigation: the TUI client holds notifications in an in-memory ring buffer only
          (useNotifications.ts, cap 50, no file persistence, no tRPC read scope).
          No notification history is available in the web UI.
          Fabricating a count or list is explicitly prohibited. */}
      <SCard style={{ marginTop: 12, maxWidth: 760 }}>
        <SCardHeader title={L.stRecentNotifications} right={L.stRecentNotifRight} />
        <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: '#D9DCE3',
              flex: 'none',
              marginTop: 5,
            }}
          />
          <span style={{ fontSize: 10.5, color: '#98A1B0', lineHeight: 1.6 }}>
            {L.stRecentNotifNote}
          </span>
        </div>
      </SCard>
    </>
  );
}

export function HooksPanel({ snapshot }: { snapshot: ConfigSnapshot }) {
  const L = useVocab();
  const hooks = snapshot.hooks;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1.35fr 1fr',
        gap: 12,
        marginTop: 12,
        alignItems: 'start',
        maxWidth: 1080,
      }}
    >
      <SCard>
        <SCardHeader title={L.stAgentHooks} right="hooks/*.mjs" />
        <div style={{ padding: '4px 14px 10px' }}>
          {hooks.length === 0 ? (
            <div style={{ padding: '8px 0', fontSize: 10.5, color: '#B6BDC9' }}>
              {L.stNoHooks}
            </div>
          ) : (
            hooks.map((f) => (
              <div
                key={f}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  padding: '5.5px 0',
                  borderBottom: '1px solid #FBFBFC',
                }}
              >
                <span style={{ font: `500 10px ${MONO}`, color: '#22262E', flex: 'none' }}>{f}</span>
                <span
                  title={L.stHookViewerInertTitle}
                  style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 600, color: '#B6BDC9', flex: 'none', cursor: 'not-allowed' }}
                >
                  {L.stView}
                </span>
              </div>
            ))
          )}
        </div>
      </SCard>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <SCard>
          <SCardHeader title={L.stThreadLifecycle} right="thread-templates" />
          <div style={{ padding: '7px 14px 9px', fontSize: 10.5, lineHeight: 1.6, color: '#5B6472' }}>
            <ThreadHookRow k="onStart" d={L.stHookOnStartDesc} />
            <ThreadHookRow k="onTransition" d={L.stHookOnTransitionDesc} />
            <ThreadHookRow k="onEnd" d={L.stHookOnEndDesc} />
          </div>
        </SCard>
        <SCard>
          <SCardHeader title={L.stSessionHooks} right="session-hooks.json" />
          <div style={{ padding: '7px 14px 9px', fontSize: 10.5, lineHeight: 1.6, color: '#5B6472' }}>
            <ThreadHookRow k="onNew" d="new-session-hook.mjs · 60s" />
            <ThreadHookRow k="onMessageEnd" d={L.stHookNotConfigured} muted />
          </div>
        </SCard>
        <div
          style={{
            background: '#FBFBFC',
            border: '1px solid #EFF1F5',
            borderRadius: 10,
            padding: '9px 13px',
            fontSize: 10,
            lineHeight: 1.7,
            color: '#8A93A2',
          }}
        >
          {L.stHooksFootNote}
        </div>
      </div>
    </div>
  );
}

function ThreadHookRow({ k, d, muted }: { k: string; d: string; muted?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4.5px 0' }}>
      <span style={{ font: `600 10px ${MONO}`, color: muted ? '#8A93A2' : '#191C22', width: 104, flex: 'none' }}>
        {k}
      </span>
      <span style={{ color: muted ? '#B6BDC9' : undefined }}>{d}</span>
    </div>
  );
}

export function AdvancedPanel({ snapshot }: { snapshot: ConfigSnapshot }) {
  const L = useVocab();
  const idx = indexEnv(snapshot.env);
  return (
    <SCard style={{ marginTop: 12, maxWidth: 760 }}>
      {ADVANCED_FLAGS.map((f) => (
        <div
          key={f.env}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 14px',
            borderBottom: '1px solid #F7F8FA',
          }}
        >
          <Toggle on={idx[f.env]?.present === true} inert />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#191C22' }}>{L[f.titleKey]}</div>
            <div style={{ fontSize: 10.5, color: '#8A93A2', marginTop: 1 }}>{L[f.descKey]}</div>
          </div>
          <span style={{ font: `400 9px ${MONO}`, color: '#B6BDC9', flex: 'none' }}>{f.env}</span>
        </div>
      ))}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 14px',
          borderBottom: '1px solid #F7F8FA',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#191C22' }}>{L.advConc}</div>
          <div style={{ fontSize: 10.5, color: '#8A93A2', marginTop: 1 }}>
            {L.stAdvConcNote}
          </div>
        </div>
        <span
          style={{
            font: `500 10.5px ${MONO}`,
            color: idx['TASK_DISPATCH_MAX_CONCURRENT']?.present ? '#191C22' : '#B6BDC9',
            border: '1px solid #E7E9EE',
            borderRadius: 7,
            padding: '4px 11px',
          }}
        >
          {idx['TASK_DISPATCH_MAX_CONCURRENT']?.present ? L.stSet : L.stAuto}
        </span>
        <span style={{ font: `400 9px ${MONO}`, color: '#B6BDC9', flex: 'none' }}>
          TASK_DISPATCH_MAX_CONCURRENT
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#191C22' }}>{L.stGpuMock}</div>
          <div style={{ fontSize: 10.5, color: '#8A93A2', marginTop: 1 }}>
            {L.advMock}
          </div>
        </div>
        <span
          style={{
            font: `400 10.5px ${MONO}`,
            color: '#B6BDC9',
            border: '1px dashed #D9DCE3',
            borderRadius: 7,
            padding: '4px 11px',
          }}
        >
          {idx['CORTEX_GPU_MONITOR_MOCK']?.present ? L.stSet : '—'}
        </span>
        <span style={{ font: `400 9px ${MONO}`, color: '#B6BDC9', flex: 'none' }}>
          CORTEX_GPU_MONITOR_MOCK
        </span>
      </div>
    </SCard>
  );
}
