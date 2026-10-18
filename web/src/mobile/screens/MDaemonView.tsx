import { useRef, useState } from 'react';
import { MButton, MPill, MDot, MC, MONO } from '@/mobile/ui/kit';
import { MSettingsFrame as MScreen, MSettingsHeader as MDrillHeader,
  MSettingsBody as MScrollBody, MSettingsSurfaceCard as MCard } from './MSettingsControls';
import type { MDaemonVm, MDaemonEvent, MDaemonProcess } from './m-daemon-vm';
import { rebuildStatusTone, type DaemonRebuildVm } from '@/features/daemon/daemon-vm';
import type { DaemonRestartState } from '@/features/daemon/useDaemonResource';
import type { Tone } from '@/design/tone';
import type { ExecutionInfo } from '@cortex-agent/ui-contract';
import { connectionLabelKey, type ConnectionStatus } from '@/features/connection/connection-status';
import { mConnTone, mConnPulse } from './m-connection';
import { fmt, useVocab, type Vocab } from '@/i18n';

const EXECUTION_STATUS_KEYS: Record<ExecutionInfo['status'], keyof Vocab> = {
  running: 'dmnStatusRunning', completed: 'dmnStatusCompleted', failed: 'dmnStatusFailed',
  cancelled: 'dmnStatusCancelled', stale: 'dmnStatusStale',
};
const REBUILD_STATUS_KEYS: Record<DaemonRebuildVm['status'], keyof Vocab> = {
  running: 'dmnStatusRunning', succeeded: 'dmnStatusSucceeded', aborted: 'dmnStatusAborted', deferred: 'dmnStatusDeferred',
};
const DASH = '—';

// Dot color stays mobile-specific while status semantics come from the canonical daemon tone.
function dotColor(tone: Tone): string {
  if (tone === 'done') return MC.done;
  if (tone === 'failed') return MC.fail;
  if (tone === 'running') return MC.run;
  return MC.grayInk;
}

// ── Rebuild card: the supervisor's pipeline, one row per planned step ──────────
function RebuildCard({ rebuild }: { rebuild: DaemonRebuildVm }) {
  const L = useVocab();
  const statusKey = REBUILD_STATUS_KEYS[rebuild.status];
  return (
    <MCard padding={0} style={{ overflow: 'hidden' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 13px',
          borderBottom: `1px solid ${MC.divider}`,
        }}
      >
        <MDot color={dotColor(rebuildStatusTone(rebuild.status))} />
        <span style={{ fontSize: 13, fontWeight: 650, color: MC.ink }}>{L.dmRebuild}</span>
        <span style={{ fontSize: 12.5, color: MC.muted, fontVariantNumeric: 'tabular-nums' }}>
          {fmt(L.dmnRebuildProgress, { done: rebuild.completed, total: rebuild.total })} · {rebuild.elapsed}
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <MPill tone={rebuildStatusTone(rebuild.status)}>{statusKey ? L[statusKey] : rebuild.status}</MPill>
        </span>
      </div>
      <div
        style={{
          padding: '9px 13px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          fontSize: 13,
          lineHeight: 1.5,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {rebuild.steps.map((step) => (
          <div key={step.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <MDot color={dotColor(step.tone)} size={5} />
            <span style={{ color: step.status === 'pending' ? MC.faint : MC.sub }}>{step.name}</span>
            {step.detail && <span style={{ color: MC.faint }}>({step.detail})</span>}
            <span style={{ marginLeft: 'auto', color: MC.faint }}>{step.duration ?? DASH}</span>
          </div>
        ))}
      </div>
      <div style={{ padding: '0 13px 12px', fontSize: 12, color: MC.muted, wordBreak: 'break-word' }}>
        {L.dmnRebuildTrigger} {rebuild.reason}
        {rebuild.detail ? ` · ${rebuild.detail}` : ''}
      </div>
    </MCard>
  );
}

// ── Process row: dot (real DTO status) + process name (code face) + label + real pid/port + uptime ──
function ProcRow({ proc, border }: { proc: MDaemonProcess; border: boolean }) {
  const L = useVocab();
  const dash = DASH;
  return (
    <div
      style={{
        padding: '11px 13px 9px',
        borderBottom: border ? `1px solid ${MC.divider}` : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor(proc.tone), flex: 'none' }}
        />
        <span style={{ font: `600 12.5px ${MONO}`, color: MC.ink }}>{proc.name}</span>
        {proc.label && (
          <span style={{ fontSize: 13, color: MC.muted }}>{proc.label}</span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 12.5, color: MC.muted, fontVariantNumeric: 'tabular-nums' }}>
          {L.dmPid} {proc.pid ?? dash}
          {proc.port != null ? ` · :${proc.port}` : ''}
        </span>
      </div>
      <div style={{ fontSize: 12.5, color: MC.muted, marginTop: 4, paddingLeft: 15, fontVariantNumeric: 'tabular-nums' }}>
        {L.mUptime} {proc.uptime ?? dash}
      </div>
    </div>
  );
}

// ── HoldButton: the 强制终止 long-press-2s confirm (scheme note L926) ────────────
// Fires onConfirm only after a continuous 2s hold; releasing early cancels. A progress fill grows over
// the hold; static render (SSR / initial) shows the resting state (label, no fill) — the honest
// realization of the scheme's "长按 2s 确认".
const HOLD_MS = 2000;
function HoldButton({
  label,
  hint,
  disabled,
  onConfirm,
}: {
  label: string;
  hint: string;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const [progress, setProgress] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef(0);

  const cancel = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    timerRef.current = null;
    rafRef.current = null;
    setProgress(0);
  };
  const start = () => {
    if (disabled) return;
    startRef.current = Date.now();
    const tick = () => {
      const p = Math.min(1, (Date.now() - startRef.current) / HOLD_MS);
      setProgress(p);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    timerRef.current = setTimeout(() => {
      cancel();
      onConfirm();
    }, HOLD_MS);
  };

  const holding = progress > 0;
  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      style={{
        position: 'relative',
        flex: 1,
        height: 44,
        borderRadius: 'var(--r-control)',
        border: `1.5px solid ${MC.failBorder}`,
        background: 'var(--material-control-bg)',
        boxShadow: 'var(--material-control-shadow)',
        color: MC.fail,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 14,
        fontWeight: 600,
        boxSizing: 'border-box',
        overflow: 'hidden',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        touchAction: 'none',
        userSelect: 'none',
      }}
    >
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: `${progress * 100}%`,
          background: MC.failBg,
          transition: holding ? undefined : 'width .15s ease',
        }}
      />
      <span style={{ position: 'relative' }}>{holding ? hint : label}</span>
    </button>
  );
}

function EventRow({ ev }: { ev: MDaemonEvent }) {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <span style={{ color: MC.faint, flex: 'none' }}>{ev.time}</span>
      <span style={{ color: ev.tone === 'fail' ? MC.amberText : MC.sub }}>
        {ev.ref} · {L[EXECUTION_STATUS_KEYS[ev.status]]}
      </span>
    </div>
  );
}

export function MDaemonView({
  vm,
  connStatus,
  restartState,
  showDisconnect,
  onBack,
  onSoftRestart,
  onHardRestart,
  onDisconnect,
}: {
  vm: MDaemonVm;
  connStatus: ConnectionStatus;
  restartState: DaemonRestartState;
  /** Show the disconnect action — only in a native shell that has saved creds to clear. */
  showDisconnect: boolean;
  onBack: () => void;
  onSoftRestart: () => void;
  onHardRestart: () => void;
  onDisconnect: () => void;
}) {
  const L = useVocab();
  const pending = restartState === 'pending';
  return (
    <MScreen label="1r daemon" header={<MDrillHeader onBack={onBack}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16, fontWeight: 650, color: MC.ink }}>
            {L.dmnTitle}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            {mConnPulse(connStatus) && <MDot color={MC.amber} />}
            <MPill tone={mConnTone(connStatus)}>{L[connectionLabelKey(connStatus)]}</MPill>
          </span>
        </div>
      </MDrillHeader>}>
      <MScrollBody>
        {/* Process card — REAL rows from system.daemonStatus (dot=status, pid/port/uptime) + real counts */}
        <MCard padding={0} style={{ overflow: 'hidden' }}>
          {vm.processes.map((proc, i) => (
            <ProcRow key={proc.name} proc={proc} border={i < vm.processes.length - 1} />
          ))}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 13px',
              fontSize: 13,
              color: MC.muted,
              flexWrap: 'wrap',
              borderTop: `1px solid ${MC.divider}`,
            }}
          >
            <span>{fmt(L.dmnSchedules, { n: vm.scheduleCount })}</span>
          </div>
        </MCard>

        {/* Hot rebuild — the supervisor's own pipeline (absent on a plain install) */}
        {vm.rebuild && <RebuildCard rebuild={vm.rebuild} />}

        {/* Recent activity — repurposed from executions.list; honestly NOT the daemon event log (GAP) */}
        <MCard padding={0} style={{ overflow: 'hidden' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '10px 13px',
              borderBottom: `1px solid ${MC.divider}`,
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 650, color: MC.ink }}>{L.dmnRecentTitle}</span>
          </div>
          {vm.lastRestart === null && vm.events.length === 0 ? (
            <div style={{ padding: '12px', fontSize: 12, color: MC.muted }}>
              {L.dmnRecentEmpty}
            </div>
          ) : (
            <div
              style={{
                padding: '9px 13px',
                display: 'flex',
                flexDirection: 'column',
                gap: 7,
                font: `400 12px/1.5 ${MONO}`,
              }}
            >
              {/* Real lastRestart from system.daemonStatus (rendered first, above recent executions) */}
              {vm.lastRestart && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <span style={{ color: MC.faint, flex: 'none' }}>{vm.lastRestart.time}</span>
                  <span style={{ color: MC.sub }}>
                    {L.dmnLastRestart}
                  </span>
                </div>
              )}
              {vm.events.map((ev) => (
                <EventRow key={ev.id} ev={ev} />
              ))}
            </div>
          )}
        </MCard>

        {/* Restart card — 软重启 (soft) + 强制终止 (hard, long-press 2s) → system.restart */}
        <MCard padding="12px 13px">
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: MC.ink }}>{L.dmnRestartTitle}</span>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <MButton disabled={pending} onClick={onSoftRestart} style={{ flex: 1 }}>
              {L.dmSoftRestart}
            </MButton>
            <HoldButton
              label={L.dmnForceKill}
              hint={L.dmnHoldHint}
              disabled={pending}
              onConfirm={onHardRestart}
            />
          </div>
          <div style={{ fontSize: 12, color: MC.muted, marginTop: 8 }}>{L.dmnFooterNote}</div>
          {restartState === 'success' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
              <MDot color={MC.done} />
              <span style={{ fontSize: 13, fontWeight: 600, color: MC.done }}>{L.dmRestartSent}</span>
            </div>
          )}
          {restartState === 'error' && (
            <div style={{ marginTop: 8, fontSize: 13, fontWeight: 600, color: MC.fail }}>{L.dmRestartFailed}</div>
          )}
        </MCard>

        {/* Disconnect card — clears the saved server + token and returns to the login screen. Only in a
            native shell (isNativeShell) where there are stored creds to clear + a connect screen to
            return to. Returning to login is recoverable (re-enter creds), so it stays a neutral ink
            outline — the red force-kill ink above owns the destructive treatment. */}
        {showDisconnect && (
          <MCard padding="12px 13px">
            <MButton onClick={onDisconnect} style={{ width: '100%' }}>
              {L.dmDisconnect}
            </MButton>
            <div style={{ fontSize: 12, color: MC.muted, marginTop: 8, textAlign: 'center' }}>
              {L.dmnDisconnectNote}
            </div>
          </MCard>
        )}
      </MScrollBody>
    </MScreen>
  );
}
