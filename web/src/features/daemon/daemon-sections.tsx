import type { CSSProperties, ReactNode } from 'react';
import type { Tone } from '@/design/tone';
import { Button } from '@/design';
import { useVocab, type Vocab } from '@/i18n';
import { dateTime } from '@/i18n/time-format';
import { rebuildStatusTone, type DaemonProcessVm, type DaemonRebuildVm, type DaemonVm } from './daemon-vm';
import type { DaemonRestartState } from './useDaemonResource';

// The daemon sheet's body, in the v2 section grammar: a sentence-case heading over a hairline, then
// rows split by fainter hairlines. Nothing in here is boxed except the hard-restart confirmation,
// the one thing the user has to act on.

const TONE_COLOR: Record<Tone, string> = {
  done: 'var(--proto-success)',
  failed: 'var(--proto-danger)',
  running: 'var(--pill-running-fg)',
  waiting: 'var(--pill-waiting-fg)',
  cancelled: 'var(--pill-cancelled-fg)',
};

function toneColor(tone: Tone): string {
  return TONE_COLOR[tone] ?? TONE_COLOR.cancelled;
}

// Process / rebuild status values from the server map through these vocab keys; anything unlisted
// is shown as sent.
const STATUS_KEYS: Record<string, keyof Vocab> = {
  running: 'dmnStatusRunning', stopped: 'dmnStatusStopped', unknown: 'dmnStatusUnknown',
  succeeded: 'dmnStatusSucceeded', aborted: 'dmnStatusAborted', deferred: 'dmnStatusDeferred',
};

function statusWord(L: Vocab, status: string): string {
  return Object.hasOwn(STATUS_KEYS, status) ? L[STATUS_KEYS[status]] : status;
}

const META: CSSProperties = { fontSize: 11, color: 'var(--proto-muted)', fontVariantNumeric: 'tabular-nums' };
const ROW_TITLE: CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--proto-ink)' };
const ROW_DESC: CSSProperties = { fontSize: 10.5, color: 'var(--proto-muted-2)', marginTop: 1 };
const ROW_LINE = '1px solid var(--proto-line-2)';

function Dot({ tone }: { tone: Tone }) {
  return (
    <span style={{ width: 16, flex: 'none', display: 'flex', justifyContent: 'center' }}>
      <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: toneColor(tone) }} />
    </span>
  );
}

/** The normal state reads in the quiet meta colour; anything else takes its tone. */
function StatusText({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span data-daemon-status="" style={{ ...META, fontSize: 11.5, marginLeft: 'auto', color: tone === 'done' ? 'var(--proto-muted)' : toneColor(tone) }}>
      {children}
    </span>
  );
}

export function DaemonSection({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section data-daemon-section="" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, paddingBottom: 6, borderBottom: '1px solid var(--proto-line-3)' }}>
        <h3 style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: 'var(--proto-ink)' }}>{title}</h3>
        {meta}
      </div>
      {children}
    </section>
  );
}

function ProcessRow({ proc, first }: { proc: DaemonProcessVm; first: boolean }) {
  const L = useVocab();
  return (
    <div data-daemon-process={proc.name} style={{ padding: '8px 0', borderTop: first ? 'none' : ROW_LINE }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Dot tone={proc.tone} />
        <span style={ROW_TITLE}>{proc.name}</span>
        <span style={{ ...META, color: 'var(--proto-muted-3)' }}>{proc.label}</span>
        <StatusText tone={proc.tone}>{statusWord(L, proc.status)}</StatusText>
      </div>
      <div style={{ ...META, display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 2, paddingLeft: 24 }}>
        {proc.uptime && <span>{L.dmUp} {proc.uptime}</span>}
        {proc.pid != null && <span>{L.dmPid} {proc.pid}</span>}
        {proc.port != null && <span>{L.dmPort} :{proc.port}</span>}
      </div>
    </div>
  );
}

export function ProcessSection({ processes }: { processes: DaemonVm['processes'] }) {
  const L = useVocab();
  if (processes.length === 0) return null;
  return (
    <DaemonSection title={L.dmnProcessesTitle}>
      {processes.map((proc, i) => <ProcessRow key={proc.name} proc={proc} first={i === 0} />)}
    </DaemonSection>
  );
}

function stepGlyph(status: string): string {
  if (status === 'running') return '▸';
  return status === 'pending' ? '·' : '●';
}

export function RebuildSection({ rebuild }: { rebuild: DaemonRebuildVm | null }) {
  const L = useVocab();
  if (!rebuild) return null;
  const tone = rebuildStatusTone(rebuild.status);
  const meta = (
    <>
      <span style={META}>{rebuild.completed}/{rebuild.total} · {rebuild.elapsed}</span>
      <StatusText tone={tone}>{statusWord(L, rebuild.status)}</StatusText>
    </>
  );
  return (
    <DaemonSection title={L.dmRebuild} meta={meta}>
      <div style={{ display: 'flex', gap: '2px 12px', flexWrap: 'wrap', padding: '8px 0 0', fontSize: 11.5 }}>
        {rebuild.steps.map((step) => (
          <span key={step.name} data-rebuild-step={step.name} style={{ color: 'var(--proto-ink-2)', whiteSpace: 'nowrap' }}>
            <span aria-hidden="true" style={{ color: toneColor(step.tone), marginRight: 4 }}>{stepGlyph(step.status)}</span>
            {step.name}
            {step.duration && <span style={{ ...META, fontSize: 11.5 }}> {step.duration}</span>}
            {step.detail && <span style={{ ...META, fontSize: 11.5 }}> ({step.detail})</span>}
          </span>
        ))}
      </div>
      <div style={{ ...META, marginTop: 4, wordBreak: 'break-word' }}>
        {L.dmReason}: {rebuild.reason}
        {rebuild.detail ? ` · ${rebuild.detail}` : ''}
      </div>
    </DaemonSection>
  );
}

export function RecentSection({ lastRestart }: { lastRestart: DaemonVm['lastRestart'] }) {
  const L = useVocab();
  if (!lastRestart?.at) return null;
  return (
    <DaemonSection title={L.dmnRecentTitle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0 0' }}>
        <span style={{ fontSize: 12, color: 'var(--proto-ink-2)' }}>{L.dmnLastRestart}</span>
        <span style={{ ...META, fontSize: 11.5, marginLeft: 'auto' }}>{dateTime(lastRestart.at) ?? '—'}</span>
      </div>
    </DaemonSection>
  );
}

export function ActionRow({ title, desc, danger = false, first = false, children }: {
  title: string; desc: string; danger?: boolean; first?: boolean; children: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: first ? 'none' : ROW_LINE }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ ...ROW_TITLE, color: danger ? 'var(--proto-danger)' : 'var(--proto-ink)' }}>{title}</div>
        <div style={ROW_DESC}>{desc}</div>
      </div>
      {children}
    </div>
  );
}

interface RestartProps {
  confirmHard: boolean;
  restartState: DaemonRestartState;
  onSoft: () => void;
  onArmHard: () => void;
  onCancelHard: () => void;
  onHard: () => void;
}

function HardConfirm({ restartState, onCancelHard, onHard }: RestartProps) {
  const L = useVocab();
  const pending = restartState === 'pending';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 10 }}>
      <div style={{ boxShadow: '0 0 0 1px var(--proto-amber-border)', background: 'var(--proto-amber-bg)', borderRadius: 'var(--r-control)', padding: '10px 14px' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--proto-amber-fg)' }}>{L.dmHardConfirm}</div>
        <div style={{ fontSize: 11.5, color: 'var(--proto-muted)', marginTop: 4, lineHeight: 1.5 }}>{L.dmHardConfirmDetail}</div>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button size="sm" data-action="hard-cancel" onClick={onCancelHard}>{L.dmConfirmCancel}</Button>
        <Button size="sm" variant="danger" data-action="hard-proceed" disabled={pending} onClick={onHard}>
          {pending ? '...' : L.dmConfirmProceed}
        </Button>
      </div>
    </div>
  );
}

export function RestartSection(props: RestartProps) {
  const L = useVocab();
  const pending = props.restartState === 'pending';
  return (
    <DaemonSection title={L.dmnRestartTitle}>
      {props.confirmHard ? <HardConfirm {...props} /> : (
        <>
          <ActionRow title={L.dmSoftRestart} desc={L.dmSoftRestartDesc} first>
            <Button size="sm" data-action="soft-restart" disabled={pending} onClick={props.onSoft}>{L.dmSoftRestart}</Button>
          </ActionRow>
          <ActionRow title={L.dmHardRestart} desc={L.dmHardRestartDesc} danger>
            <Button size="sm" variant="danger-outline" data-action="hard-arm" onClick={props.onArmHard}>{L.dmHardRestart}</Button>
          </ActionRow>
        </>
      )}
      <RestartFeedback state={props.restartState} />
    </DaemonSection>
  );
}

function RestartFeedback({ state }: { state: DaemonRestartState }) {
  const L = useVocab();
  if (state !== 'success' && state !== 'error') return null;
  const ok = state === 'success';
  return (
    <div role="status" style={{ padding: '8px 0 0', fontSize: 11.5, fontWeight: 600, color: ok ? 'var(--proto-success)' : 'var(--proto-danger)' }}>
      {ok ? L.dmRestartSent : L.dmRestartFailed}
    </div>
  );
}
