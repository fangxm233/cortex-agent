import { Button, DegradedState, ID, MonoText, StatusPill } from '@/design';

// The four degraded variants (design §5, design 10c), each a composition of the
// `DegradedState` primitive + existing primitives. Pure presentational — no real data
// (Machines/threads/budget wiring are Stage 3/5/7). Demonstrates the unified color
// language: amber(waiting) / red(human) / blue(info).

// 10c-①  rate-limit throttle — auto-paused, resumes after window reset (amber/waiting).
function RateLimitDemo() {
  return (
    <DegradedState
      severity="waiting"
      pulse
      title="Rate limit reached — 3 items auto-paused"
      meta="resets 14:00 · 2h 08m"
    >
      <div className="flex flex-col gap-1g">
        <PausedItem label="session morning-review — paused" note="auto-resumes after reset" />
        <PausedItem label="schedule inbox-sweep — paused" note="pausedBy: rate-limit" />
        <PausedItem label="task dispatch — held by guard, queue kept" note="beforeRunGuard" muted />
      </div>
    </DegradedState>
  );
}

function PausedItem({ label, note, muted }: { label: string; note: string; muted?: boolean }) {
  return (
    <div className="flex items-center gap-1g rounded-card border border-card px-1.5g py-1g">
      <span
        className={['h-0.5g w-0.5g flex-none rounded-full', muted ? 'bg-state-gray' : 'bg-state-wait']
          .join(' ')}
      />
      <span className="text-ui text-state-ink/80">{label}</span>
      <MonoText muted className="ml-auto text-ui">
        {note}
      </MonoText>
    </div>
  );
}

// 10c-②  backend fallback — transient in-step note, does NOT interrupt the thread (blue/info).
function BackendFallbackDemo() {
  return (
    <DegradedState
      severity="info"
      title="step 3 · executor:analyze"
      meta="fallback chain from profiles.json"
    >
      <div className="flex flex-col gap-0.5g font-mono text-ui">
        <div className="flex gap-1g">
          <span className="flex-none text-pill-failed-fg">✕</span>
          <span className="text-state-ink/70">claude · print — transient backend error (exit 1)</span>
        </div>
        <div className="flex gap-1g">
          <span className="flex-none text-pill-done-fg">→</span>
          <span className="text-state-ink/80">
            fallback <span className="text-pill-running-fg">pi</span> — inherits main profile, step re-run
          </span>
        </div>
        <div className="flex gap-1g">
          <span className="flex-none text-state-ink/30"> </span>
          <span className="text-state-ink/40">artifact.md untouched · completed steps not re-run</span>
        </div>
      </div>
      <div className="flex items-center gap-1g">
        <StatusPill tone="running" label="● retrying" />
      </div>
    </DegradedState>
  );
}

// 10c-③  machine offline — needs human attention: exec lost, task reopen rescue (red/human).
function MachineOfflineDemo() {
  return (
    <DegradedState
      severity="human"
      title={
        <span className="flex items-center gap-1g">
          <MonoText>gpu-01</MonoText>
          <StatusPill tone="failed" label="offline" />
        </span>
      }
      meta="last seen 09:12 · ws closed"
      detail={
        <div className="flex flex-col gap-1g">
          <div className="rounded-card border border-card bg-surface-canvas-alt px-1.5g py-1g font-mono text-ui text-state-ink/70">
            exec_31c2 → <span className="text-pill-failed-fg">lost</span> (3 missed heartbeats) · thread notified
          </div>
          <div className="rounded-card border border-card bg-surface-canvas-alt px-1.5g py-1g font-mono text-ui text-state-ink/70">
            T-045 pending held · 4h no callback auto-clears tracking · reopenable
          </div>
        </div>
      }
      actions={
        <>
          <Button variant="primary" size="sm">
            Reopen task
          </Button>
          <span className="self-center text-ui text-state-ink/50">
            cortex-client auto-reconnects; run state re-read from state file
          </span>
        </>
      }
    />
  );
}

// 10c-④  over-budget pause — thread enters waiting (not failed); approve/reject/adjust (amber/waiting).
function OverBudgetDemo() {
  return (
    <DegradedState
      severity="waiting"
      pulse
      title="Thread paused — would exceed today's budget"
      meta="waiting"
      detail={
        <span>
          Next dispatch est. <MonoText>$6.40</MonoText>, remaining today{' '}
          <MonoText className="text-pill-failed-fg">$1.10</MonoText> — pre-check held it before dispatch;
          approval queued <ID value="APR-0008" />
        </span>
      }
      actions={
        <>
          <Button variant="primary" size="sm">
            Approve once
          </Button>
          <Button variant="secondary" size="sm">
            Reject
          </Button>
          <Button variant="secondary" size="sm">
            Adjust budget…
          </Button>
        </>
      }
    />
  );
}

export function DegradedDemos() {
  return (
    <div className="grid grid-cols-1 gap-2g md:grid-cols-2">
      <RateLimitDemo />
      <BackendFallbackDemo />
      <MachineOfflineDemo />
      <OverBudgetDemo />
    </div>
  );
}
