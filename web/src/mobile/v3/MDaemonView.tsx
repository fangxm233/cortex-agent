// @ds-adherence-ignore -- mobile v3 raw px/hex/font by design §8.3 (scheme-mobile.dc.html 1r L888-932)
// 1r Daemon 状态 — Daemon liveness + restart controls, drilled from 1l 设置. Pure presentational:
// takes the built vm + copy + callbacks (no tRPC). The process card now renders REAL name / label /
// status / pid / port / uptime from `system.daemonStatus` (the same query the desktop 17a modal uses);
// any DTO field that is null is shown as an honest `—`. The daemon.log event stream still has no query
// scope → the 最近事件 card surfaces the REAL lastRestart plus recent executions (see m-daemon-vm 守则11).
import { useRef, useState, type CSSProperties } from 'react';
import { MScreen, MDrillHeader, MScrollBody, MCard, MPill, MDot, MC, MONO } from '@/mobile/ui/kit';
import type { MDaemonVm, MDaemonEvent, MDaemonProcess, MProcStatus } from './m-daemon-vm';
import type { ExecutionInfo } from '@cortex-agent/ui-contract';
import type { ConnectionStatus } from '@/features/connection/connection-status';
import { mConnTone, mConnPulse } from './m-connection';

export interface MDaemonCopy {
  title: string;
  // Header pill: live UI<->server connectivity labels.
  connConnected: string;
  connConnecting: string;
  connReconnecting: string;
  connDisconnected: string;
  threadsRunning: (n: number) => string;
  schedules: (n: number) => string;
  /** Mono label prefix for the uptime metric (technical token, e.g. `uptime`). */
  uptimeLabel: string;
  /** Honest placeholder for any null DTO metric. */
  dash: string;
  /** Label for the real lastRestart event row (e.g. `上次重启`). */
  lastRestartLabel: string;
  recentTitle: string;
  recentGap: string;
  recentEmpty: string;
  status: Record<ExecutionInfo['status'], string>;
  softRestart: string;
  forceKill: string;
  softNote: (n: number) => string;
  holdHint: string;
  footerNote: string;
  sent: string;
  failed: string;
  /** Disconnect action label (e.g. 断开连接) — clears saved creds + returns to the login screen. */
  disconnect: string;
  /** Sub-line under the disconnect button explaining what it does. */
  disconnectNote: string;
}

export type RestartState = 'idle' | 'pending' | 'success' | 'error';

// Dot color from the DTO status — matches the desktop 17a modal (running=green, unknown=amber, stopped=red).
function dotColor(status: MProcStatus): string {
  if (status === 'running') return MC.done;
  if (status === 'unknown') return MC.amber;
  return MC.fail;
}

// ── Process row: dot (real DTO status) + mono name + label + real pid/port + uptime/extras sub-line ──
function ProcRow({ proc, copy, border }: { proc: MDaemonProcess; copy: MDaemonCopy; border: boolean }) {
  const dash = copy.dash;
  return (
    <div
      style={{
        padding: '11px 13px 9px',
        borderBottom: border ? `1px solid ${MC.divider}` : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor(proc.status), flex: 'none' }}
        />
        <span style={{ font: `600 12.5px ${MONO}`, color: MC.ink }}>{proc.name}</span>
        {proc.label && (
          <span style={{ font: `400 9.5px ${MONO}`, color: MC.muted }}>{proc.label}</span>
        )}
        <span style={{ marginLeft: 'auto', font: `400 9.5px ${MONO}`, color: MC.muted }}>
          pid {proc.pid ?? dash}
          {proc.port != null ? ` · :${proc.port}` : ''}
        </span>
      </div>
      <div style={{ font: `400 9.5px ${MONO}`, color: MC.muted, marginTop: 4, paddingLeft: 15 }}>
        {copy.uptimeLabel} {proc.uptime ?? dash}
        {proc.extras.map((e) => ` · ${e.k} ${e.v}`).join('')}
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
        borderRadius: 11,
        border: `1.5px solid ${MC.failBorder}`,
        background: 'var(--proto-card)',
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

const OUTLINE_BTN: CSSProperties = {
  flex: 1,
  height: 44,
  borderRadius: 11,
  border: `1.5px solid var(--proto-line-3)`,
  background: 'var(--proto-card)',
  color: MC.ink,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 14,
  fontWeight: 600,
  boxSizing: 'border-box',
  cursor: 'pointer',
};

function EventRow({ ev, copy }: { ev: MDaemonEvent; copy: MDaemonCopy }) {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <span style={{ color: MC.faint, flex: 'none' }}>{ev.time}</span>
      <span style={{ color: ev.tone === 'fail' ? MC.amberText : MC.sub }}>
        {ev.ref} · {copy.status[ev.status]}
      </span>
    </div>
  );
}

// Header pill: live UI<->server connectivity — supersedes the former query-inferred ok/err pill.
type MConnLabelKey = 'connConnected' | 'connConnecting' | 'connReconnecting' | 'connDisconnected';
const CONN_LABEL: Record<ConnectionStatus, MConnLabelKey> = {
  connected: 'connConnected',
  connecting: 'connConnecting',
  reconnecting: 'connReconnecting',
  disconnected: 'connDisconnected',
};

export function MDaemonView({
  vm,
  copy,
  connStatus,
  restartState,
  showDisconnect,
  onBack,
  onSoftRestart,
  onHardRestart,
  onDisconnect,
}: {
  vm: MDaemonVm;
  copy: MDaemonCopy;
  connStatus: ConnectionStatus;
  restartState: RestartState;
  /** Show the disconnect action — only in a native shell that has saved creds to clear. */
  showDisconnect: boolean;
  onBack: () => void;
  onSoftRestart: () => void;
  onHardRestart: () => void;
  onDisconnect: () => void;
}) {
  const pending = restartState === 'pending';
  return (
    <MScreen label="1r Daemon 状态">
      <MDrillHeader onBack={onBack}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span style={{ fontSize: 16, fontWeight: 650, color: MC.ink, letterSpacing: '-.01em' }}>
            {copy.title}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            {mConnPulse(connStatus) && <MDot color={MC.amber} pulse />}
            <MPill tone={mConnTone(connStatus)}>{copy[CONN_LABEL[connStatus]]}</MPill>
          </span>
        </div>
      </MDrillHeader>

      <MScrollBody gap={10}>
        {/* Process card — REAL rows from system.daemonStatus (dot=status, pid/port/uptime) + real counts */}
        <MCard padding={0} style={{ overflow: 'hidden' }}>
          {vm.processes.map((proc, i) => (
            <ProcRow key={proc.name} proc={proc} copy={copy} border={i < vm.processes.length - 1} />
          ))}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 13px',
              font: `400 10px ${MONO}`,
              color: MC.muted,
              flexWrap: 'wrap',
              borderTop: `1px solid ${MC.divider}`,
            }}
          >
            <span>{copy.threadsRunning(vm.threadCount)}</span>
            <span>·</span>
            <span>{copy.schedules(vm.scheduleCount)}</span>
          </div>
        </MCard>

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
            <span style={{ fontSize: 12, fontWeight: 650, color: MC.ink }}>{copy.recentTitle}</span>
            <span style={{ marginLeft: 'auto', font: `400 9.5px ${MONO}`, color: MC.faint }}>
              executions.list
            </span>
          </div>
          {vm.lastRestart === null && vm.events.length === 0 ? (
            <div style={{ padding: '14px 13px', font: `400 10px ${MONO}`, color: MC.faint }}>
              {copy.recentEmpty}
            </div>
          ) : (
            <div
              style={{
                padding: '9px 13px',
                display: 'flex',
                flexDirection: 'column',
                gap: 7,
                font: `400 10px/1.5 ${MONO}`,
              }}
            >
              {/* Real lastRestart from system.daemonStatus (rendered first, above recent executions) */}
              {vm.lastRestart && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <span style={{ color: MC.faint, flex: 'none' }}>{vm.lastRestart.time}</span>
                  <span style={{ color: MC.sub }}>
                    {copy.lastRestartLabel}
                    {vm.lastRestart.reason ? ` · ${vm.lastRestart.reason}` : ''}
                  </span>
                </div>
              )}
              {vm.events.map((ev) => (
                <EventRow key={ev.id} ev={ev} copy={copy} />
              ))}
            </div>
          )}
          <div style={{ padding: '0 13px 10px', font: `400 9px ${MONO}`, color: MC.faint }}>
            {copy.recentGap}
          </div>
        </MCard>

        {/* Restart card — 软重启 (soft) + 强制终止 (hard, long-press 2s) → system.restart */}
        <MCard padding="12px 13px">
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: MC.ink }}>{copy.softRestart}</span>
            <span style={{ marginLeft: 'auto', font: `400 9.5px ${MONO}`, color: MC.faint }}>
              {copy.softNote(vm.threadCount)}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button
              type="button"
              disabled={pending}
              onClick={onSoftRestart}
              style={{ ...OUTLINE_BTN, opacity: pending ? 0.5 : 1, cursor: pending ? 'default' : 'pointer' }}
            >
              {copy.softRestart}
            </button>
            <HoldButton
              label={copy.forceKill}
              hint={copy.holdHint}
              disabled={pending}
              onConfirm={onHardRestart}
            />
          </div>
          <div style={{ font: `400 9px ${MONO}`, color: MC.faint, marginTop: 8 }}>{copy.footerNote}</div>
          {restartState === 'success' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
              <MDot color={MC.done} />
              <span style={{ fontSize: 11, fontWeight: 600, color: MC.done }}>{copy.sent}</span>
            </div>
          )}
          {restartState === 'error' && (
            <div style={{ marginTop: 8, fontSize: 11, fontWeight: 600, color: MC.fail }}>{copy.failed}</div>
          )}
        </MCard>

        {/* Disconnect card — clears the saved server + token and returns to the login screen. Only in a
            native shell (isNativeShell) where there are stored creds to clear + a connect screen to
            return to. Returning to login is recoverable (re-enter creds), so it stays a neutral ink
            outline — the red force-kill ink above owns the destructive treatment. */}
        {showDisconnect && (
          <MCard padding="12px 13px">
            <button type="button" onClick={onDisconnect} style={{ ...OUTLINE_BTN }}>
              {copy.disconnect}
            </button>
            <div style={{ font: `400 9px ${MONO}`, color: MC.faint, marginTop: 8, textAlign: 'center' }}>
              {copy.disconnectNote}
            </div>
          </MCard>
        )}
      </MScrollBody>
    </MScreen>
  );
}
