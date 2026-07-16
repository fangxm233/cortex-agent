// @ds-adherence-ignore -- mobile v3 raw px/hex/font by design §8.3 (scheme-mobile.dc.html 1r L888-932)
// 1r Daemon 状态 — Daemon liveness + restart controls, drilled from 1l 设置. Pure presentational:
// takes the built vm + copy + callbacks (no tRPC). The scheme's rich process panel (pid/port/uptime/
// api p50/ws count) and daemon.log event stream have no tRPC query source on this surface, so they are
// rendered as honest gaps (see m-daemon-vm 守则11 note) — only real counts + restart actions are shown.
import { useRef, useState, type CSSProperties } from 'react';
import { MScreen, MDrillHeader, MScrollBody, MCard, MPill, MDot, MC, MONO } from '@/mobile/ui/kit';
import type { MDaemonVm, MDaemonEvent } from './m-daemon-vm';
import type { ExecutionInfo } from '@cortex-agent/ui-contract';

export interface MDaemonCopy {
  title: string;
  statusOk: string;
  statusErr: string;
  threadsRunning: (n: number) => string;
  schedules: (n: number) => string;
  metricsGap: string;
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
}

export type RestartState = 'idle' | 'pending' | 'success' | 'error';

// ── Process row: dot (liveness implied by successful queries) + mono name ──────
function ProcRow({ name, live, border }: { name: string; live: boolean; border: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '11px 13px 9px',
        borderBottom: border ? `1px solid ${MC.divider}` : undefined,
      }}
    >
      <span
        style={{ width: 7, height: 7, borderRadius: '50%', background: live ? MC.done : MC.fail, flex: 'none' }}
      />
      <span style={{ font: `600 12.5px ${MONO}`, color: MC.ink }}>{name}</span>
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
        background: '#fff',
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
  border: `1.5px solid #D9DCE3`,
  background: '#fff',
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

export function MDaemonView({
  vm,
  copy,
  restartState,
  onBack,
  onSoftRestart,
  onHardRestart,
}: {
  vm: MDaemonVm;
  copy: MDaemonCopy;
  restartState: RestartState;
  onBack: () => void;
  onSoftRestart: () => void;
  onHardRestart: () => void;
}) {
  const pending = restartState === 'pending';
  return (
    <MScreen label="1r Daemon 状态">
      <MDrillHeader onBack={onBack}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span style={{ fontSize: 16, fontWeight: 650, color: MC.ink, letterSpacing: '-.01em' }}>
            {copy.title}
          </span>
          {vm.ok ? (
            <MPill tone="done">{copy.statusOk}</MPill>
          ) : (
            <MPill tone="failed">{copy.statusErr}</MPill>
          )}
        </div>
      </MDrillHeader>

      <MScrollBody gap={10}>
        {/* Process card — dots = liveness implied by successful queries; real counts; metrics are a GAP */}
        <MCard padding={0} style={{ overflow: 'hidden' }}>
          <ProcRow name="cortex-server" live={vm.processes[0]?.live ?? vm.ok} border />
          <ProcRow name="cortex-daemon" live={vm.processes[1]?.live ?? vm.ok} border />
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 13px 4px',
              font: `400 10px ${MONO}`,
              color: MC.muted,
              flexWrap: 'wrap',
            }}
          >
            <span>{copy.threadsRunning(vm.threadCount)}</span>
            <span>·</span>
            <span>{copy.schedules(vm.scheduleCount)}</span>
          </div>
          {/* GAP: pid / port / uptime / api p50 / ws count have no tRPC query source on this surface. */}
          <div style={{ padding: '0 13px 10px', font: `400 9px ${MONO}`, color: MC.faint }}>
            {copy.metricsGap}
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
          {vm.events.length === 0 ? (
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
      </MScrollBody>
    </MScreen>
  );
}
