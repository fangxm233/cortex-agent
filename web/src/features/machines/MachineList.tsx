import { Fragment, useState, type CSSProperties, type ReactNode } from 'react';
import type { MachineInfo } from '@cortex-agent/ui-contract';
import { fmt, useLang, useVocab } from '@/i18n';
import { useMachinesResource, type MachineDetailResource } from './useMachinesResource';
import type { MachineGpuRow, MachineMeter } from './machine-detail-vm';
import { machineHeartbeatText, machineMetaText } from './machines-menu-vm';

// Machine rows for the top-bar machines menu. A collapsed row shows machines.list (status dot,
// name, heartbeat, and a hardware · OS · connected line). Expanding a row lazily fetches
// machines.detail: a live probe of the device (GPU telemetry, host vitals). The probe is an RPC
// round trip, so it only runs while the menu is open and the row is expanded.
//
// The rows sit straight on the menu sheet, divided by hairlines — no card per machine. Everything
// is in the UI face with tabular figures: a machine name, a percentage and a byte count are labels
// and numbers, not code.

const ROW_TEXT: CSSProperties = { fontSize: 12.5, color: 'var(--proto-muted)' };
const VALUE: CSSProperties = {
  color: 'var(--proto-ink)', textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
};
// Secondary readings and meta lines: the quietest tier that still carries text (faint is for glyphs).
const QUIET: CSSProperties = { color: 'var(--proto-muted-3)' };
// Label · bar · value. The value column has a floor so the vitals block and the GPU block below it
// end their bars at the same x whenever the values fit.
const METER_GRID: CSSProperties = {
  display: 'grid', gridTemplateColumns: 'minmax(44px, max-content) minmax(40px, 1fr) minmax(118px, max-content)',
  alignItems: 'center', columnGap: 12, ...ROW_TEXT,
};

function Chevron({ open, size = 9 }: { open: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
      style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s', flexShrink: 0 }}
    >
      <path d="M3.5 2L6.5 5L3.5 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** Saturation reads as pressure: amber past 75%, red past 90%. */
function pressureTone(percent: number): { bar: string; text: string } | null {
  if (percent >= 90) return { bar: 'var(--proto-danger)', text: 'var(--proto-danger)' };
  if (percent >= 75) return { bar: 'var(--proto-amber)', text: 'var(--proto-amber-fg)' };
  return null;
}

function Bar({ percent }: { percent: number }) {
  const tone = pressureTone(percent);
  return (
    <span style={{ height: 4, borderRadius: 'var(--r-pill)', background: 'var(--proto-line)', overflow: 'hidden', minWidth: 0 }}>
      <span style={{ display: 'block', width: `${percent}%`, height: '100%', borderRadius: 'var(--r-pill)',
        background: tone?.bar ?? 'var(--proto-accent)' }} />
    </span>
  );
}

/** `17.4 / 250.7 GB` → the reading in ink and its denominator muted, the way a gauge is read. */
function Reading({ text, color }: { text: string; color?: string }) {
  const cut = text.indexOf(' / ');
  if (cut < 0 || color) return <span style={{ ...VALUE, color: color ?? VALUE.color }}>{text}</span>;
  return <span style={VALUE}>{text.slice(0, cut)}<span style={QUIET}>{text.slice(cut)}</span></span>;
}

function Section({ children, divided = false }: { children: ReactNode; divided?: boolean }) {
  return (
    <div style={{ padding: divided ? '10px 0 0' : '0', marginTop: divided ? 10 : 0,
      borderTop: divided ? '1px solid var(--proto-line-2)' : 0 }}>
      {children}
    </div>
  );
}

/** Host vitals as aligned rows: label · bar · value. A pressured meter tints its value too. */
function Vitals({ meters }: { meters: MachineMeter[] }) {
  return (
    <div data-machine-vitals="" style={METER_GRID}>
      {meters.map((meter) => <Fragment key={meter.key}>
        <span style={{ lineHeight: '26px', whiteSpace: 'nowrap' }}>{meter.label}</span>
        <Bar percent={meter.percent} />
        <Reading text={meter.text} color={pressureTone(meter.percent)?.text} />
      </Fragment>)}
    </div>
  );
}

function processCountText(gpu: MachineGpuRow, L: ReturnType<typeof useVocab>): string {
  const total = gpu.processes.length + gpu.hiddenProcessCount;
  if (total === 0) return '';
  return total === 1 ? L.mGpuProcOne : fmt(L.mGpuProcMany, { n: total });
}

/** One GPU: `GPU 0` · bar · `5% · 69°C`, then memory / power / process count under the bar. The
 *  process list folds behind that count; it is the long part, and the usual question is "how full". */
function GpuRow({ gpu, showName, open, onToggle }: {
  gpu: MachineGpuRow; showName: boolean; open: boolean; onToggle: () => void;
}) {
  const L = useVocab();
  const procs = processCountText(gpu, L);
  const facts = [gpu.memText, gpu.powerText, procs].filter(Boolean).join(' · ');
  const sub: CSSProperties = { gridColumn: '2 / -1', ...QUIET, fontSize: 12, lineHeight: '22px', overflowWrap: 'anywhere' };
  return <>
    <span style={{ lineHeight: '26px', whiteSpace: 'nowrap' }}>{L.mGpu} {gpu.index}</span>
    <Bar percent={gpu.utilPercent} />
    <span style={VALUE}>{gpu.utilText}<span style={QUIET}> · {gpu.tempText}</span></span>
    {showName && <div title={gpu.name} style={{ ...sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{gpu.name}</div>}
    {gpu.processes.length > 0 ? (
      <button type="button" className="content-text-action" aria-expanded={open} onClick={onToggle}
        data-gpu-processes={gpu.index}
        style={{ ...sub, display: 'flex', alignItems: 'center', gap: 5, textAlign: 'left', cursor: 'pointer',
          fontVariantNumeric: 'tabular-nums' }}>
        <span>{facts}</span><Chevron open={open} size={8} />
      </button>
    ) : <div style={{ ...sub, fontVariantNumeric: 'tabular-nums' }}>{facts}</div>}
    {open && gpu.processes.map((proc) => (
      <div key={proc.pid} style={{ ...sub, display: 'flex', gap: 8, fontVariantNumeric: 'tabular-nums' }}>
        <span style={{ color: 'var(--proto-muted)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{proc.name}</span>
        <span style={{ flex: 'none' }}>{proc.memText} · {fmt(L.mGpuPid, { pid: proc.pid })}</span>
      </div>
    ))}
    {open && gpu.hiddenProcessCount > 0 && <div style={sub}>+{gpu.hiddenProcessCount}</div>}
  </>;
}

function GpuRows({ gpus, model, divided }: { gpus: MachineGpuRow[]; model: string | null; divided: boolean }) {
  // Held here, not with the machine: the folded process lists reset when the menu closes.
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const toggle = (index: number) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(index)) next.delete(index); else next.add(index);
    return next;
  });
  return (
    <Section divided={divided}>
      <div data-machine-gpus="" style={METER_GRID}>
        {gpus.map((gpu) => <GpuRow key={gpu.index} gpu={gpu} showName={!model} open={open.has(gpu.index)}
          onToggle={() => toggle(gpu.index)} />)}
      </div>
    </Section>
  );
}

function UptimeFooter({ uptime }: { uptime: string }) {
  const L = useVocab();
  if (!uptime) return null;
  return <div style={{ marginTop: 10, fontSize: 12, ...QUIET, fontVariantNumeric: 'tabular-nums' }}>{L.mUptime} {uptime}</div>;
}

function Notice({ text, tone }: { text: string; tone: 'muted' | 'danger' }) {
  return (
    <div style={{ ...ROW_TEXT, lineHeight: 1.5, color: tone === 'danger' ? 'var(--proto-danger)' : 'var(--proto-muted)' }}>
      {text}
    </div>
  );
}

/** Expanded body consumes shared lifecycle facts; the desktop keeps its own telemetry JSX. */
function MachineDetailBody({ detail }: { detail: MachineDetailResource }) {
  const L = useVocab();
  if (detail.status === 'offline') return <Notice text={L.mOfflineNoTelemetry} tone="muted" />;
  if (detail.status === 'probing') return <Notice text={L.mProbing} tone="muted" />;
  if (detail.status === 'error' || !detail.facts) return <Notice text={L.mProbeFailed} tone="danger" />;
  const vm = detail.facts;
  return <>
    {vm.probeError && <Notice text={`${L.mProbeFailed}: ${vm.probeError}`} tone="danger" />}
    {vm.meters.length > 0 && <Vitals meters={vm.meters} />}
    {vm.gpus.length > 0 && <GpuRows gpus={vm.gpus} model={vm.gpuModel} divided={vm.meters.length > 0} />}
    {!vm.probeError && vm.gpus.length === 0 && <Notice text={L.mNoGpuReported} tone="muted" />}
    <UptimeFooter uptime={detail.uptime} />
  </>;
}

/** Online is a green dot with a soft halo; offline is a hollow ring. The word lives in the name. */
function StatusDot({ online }: { online: boolean }) {
  const L = useVocab();
  const label = online ? L.mOnline : L.mOffline;
  return (
    <span style={{ width: 16, flex: 'none', display: 'inline-flex', justifyContent: 'center' }}>
      <span role="img" aria-label={label} title={label} data-machine-status={online ? 'online' : 'offline'} style={{
        width: 7, height: 7, borderRadius: '50%', boxSizing: 'border-box',
        ...(online
          ? { background: 'var(--proto-success)', boxShadow: '0 0 0 3px color-mix(in srgb, var(--proto-success) 15%, transparent)' }
          : { border: '1.5px solid var(--proto-faint)' }),
      }} />
    </span>
  );
}

function MachineHead({ machine, open, gpuModel, onToggle }: {
  machine: MachineInfo; open: boolean; gpuModel: string | null; onToggle: () => void;
}) {
  const lang = useLang();
  const heartbeat = machineHeartbeatText(machine, lang);
  const meta = machineMetaText(machine, gpuModel, lang);
  return (
    <button type="button" aria-expanded={open} onClick={onToggle} data-machine-row={machine.name}
      style={{ display: 'block', width: '100%', border: 0, padding: 0, background: 'transparent', textAlign: 'left', cursor: 'pointer' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 22 }}>
        <StatusDot online={machine.online} />
        <span title={machine.name} style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--proto-ink)', minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{machine.name}</span>
        <span style={{ display: 'inline-flex', color: 'var(--proto-faint)' }}><Chevron open={open} /></span>
        {heartbeat && <span style={{ marginLeft: 'auto', flex: 'none', fontSize: 12, ...QUIET,
          fontVariantNumeric: 'tabular-nums' }}>{heartbeat}</span>}
      </span>
      {meta && <span style={{ display: 'block', margin: '2px 0 0 24px', ...ROW_TEXT, ...QUIET,
        fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>{meta}</span>}
    </button>
  );
}

function MachineRow({ machine, open, detail, onToggle, divided }: {
  machine: MachineInfo; open: boolean; detail: MachineDetailResource | undefined; onToggle: () => void; divided: boolean;
}) {
  return <div style={{ padding: '10px 16px', borderTop: divided ? '1px solid var(--proto-line-2)' : 0 }}>
    <MachineHead machine={machine} open={open} gpuModel={detail?.facts?.gpuModel ?? null} onToggle={onToggle} />
    {open && detail && <div style={{ marginTop: 10 }}><MachineDetailBody detail={detail} /></div>}
  </div>;
}

function MachineListState({ loading, error, empty }: { loading: boolean; error: boolean; empty: boolean }) {
  const L = useVocab();
  const text = loading ? L.rpLoadingMachines : error ? L.rpFailedLoadMachines : empty ? L.mNoMachines : null;
  if (!text) return null;
  return <div style={{ padding: '6px 16px 10px', ...ROW_TEXT,
    color: error && !loading ? 'var(--proto-danger)' : 'var(--proto-muted)' }}>{text}</div>;
}

interface MachineListViewProps {
  machines: MachineInfo[];
  loading: boolean;
  error: boolean;
  expanded: ReadonlySet<string>;
  detailFor: (name: string) => MachineDetailResource | undefined;
  onToggle: (name: string) => void;
}

// No reserved scrollbar gutter on the scroller: it would pull every row's right edge in from the
// header's, which sits outside it.
export function MachineListView(props: MachineListViewProps) {
  return <div style={{ flex: 1, minHeight: 0, paddingBottom: 4, display: 'flex',
    flexDirection: 'column', overflow: 'auto' }}>
    {props.machines.map((machine, index) => <MachineRow key={machine.name} machine={machine} divided={index > 0}
      open={props.expanded.has(machine.name)} detail={props.detailFor(machine.name)}
      onToggle={() => props.onToggle(machine.name)} />)}
    <MachineListState loading={props.loading} error={props.error} empty={props.machines.length === 0} />
  </div>;
}

/** Expansion lives with the caller so it survives the menu closing; probes run only while mounted. */
export function MachineList({ expanded, onToggle }: {
  expanded: ReadonlySet<string>;
  onToggle: (name: string) => void;
}) {
  const machines = useMachinesResource([...expanded]);
  return <MachineListView machines={machines.machines} loading={machines.loading}
    error={!!machines.error} expanded={expanded} detailFor={machines.detailFor} onToggle={onToggle} />;
}
