import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Drawer,
  DrawerClose,
  EmptyState,
  ID,
  Modal,
  ModalClose,
  MonoText,
  Popover,
  SectionHeader,
  StatusPill,
  Tabs,
  Tooltip,
  TONES,
  useToast,
  type ButtonVariant,
} from '@/design';
import type { ReactNode } from 'react';
import { DegradedDemos } from './DegradedDemos';

// /kit — design-system demo surface (design §5 Stage 2). Renders every primitive
// in every variant/state so the token library can be eyeballed and reviewed. Pure
// presentational: needs no agent-server.

const DEMO_STATUSES = [
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'aborted',
  'stale',
  'open',
  'done',
];

const VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'danger'];

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2g">
      <SectionHeader title={title} />
      <Card padded>
        <div className="flex flex-wrap items-center gap-2g">{children}</div>
      </Card>
    </section>
  );
}

export function KitPage() {
  return (
    <div className="flex h-full flex-col gap-4g overflow-auto p-2g pb-6g">
      <SectionHeader
        title="Design Kit"
        description="Token-driven core primitives (design §5). All colors from tailwind tokens."
      />

      <Group title="StatusPill — tones">
        {TONES.map((tone) => (
          <StatusPill key={tone} tone={tone} label={tone} />
        ))}
      </Group>

      <Group title="StatusPill — contract statuses">
        {DEMO_STATUSES.map((status) => (
          <StatusPill key={status} status={status} />
        ))}
      </Group>

      <Group title="MonoText & ID">
        <MonoText>mono-text</MonoText>
        <MonoText muted>mono-text muted</MonoText>
        <ID value="thr_99a13064" />
        <ID value="e794" copyable />
      </Group>

      <Group title="Button — variants × sizes">
        {VARIANTS.map((variant) => (
          <Button key={variant} variant={variant} size="md">
            {variant}
          </Button>
        ))}
        {VARIANTS.map((variant) => (
          <Button key={`${variant}-sm`} variant={variant} size="sm">
            {variant} sm
          </Button>
        ))}
        <Button variant="primary" disabled>
          disabled
        </Button>
      </Group>

      <Group title="Tooltip">
        <Tooltip content="I am a token-styled tooltip">
          <Button variant="secondary">Hover me</Button>
        </Tooltip>
      </Group>

      <section className="flex flex-col gap-2g">
        <SectionHeader title="Card + header/body" count={2} />
        <Card>
          <CardHeader>
            <MonoText>card-header</MonoText>
          </CardHeader>
          <CardBody>
            <p className="text-ui text-state-ink/70">Card body content sits on the white surface.</p>
          </CardBody>
        </Card>
      </section>

      <section className="flex flex-col gap-2g">
        <SectionHeader title="Tabs" />
        <Card padded>
          <Tabs
            items={[
              { value: 'one', label: 'Overview', content: <MonoText>panel one</MonoText> },
              { value: 'two', label: 'Details', content: <MonoText>panel two</MonoText> },
              { value: 'three', label: 'Logs', content: <MonoText>panel three</MonoText> },
            ]}
          />
        </Card>
      </section>

      <section className="flex flex-col gap-2g">
        <SectionHeader
          title="Degraded states (10c)"
          description="Unified exception language — amber=waiting, red=needs-human, blue=transient note."
        />
        <DegradedDemos />
      </section>

      <section className="flex flex-col gap-2g">
        <SectionHeader
          title="Empty states (10d)"
          description="Every empty panel points to a next action — no dead wall."
        />
        <div className="grid grid-cols-1 gap-2g md:grid-cols-3">
          <EmptyState
            title="Give Cortex a mission"
            description="Describe a goal and success criteria — planning, dispatch and record-keeping follow."
            action={
              <div className="flex w-full flex-col gap-1g">
                <span className="rounded-card border border-card bg-surface-canvas-alt px-1.5g py-1g text-left text-ui text-state-ink/60">
                  "Scan arXiv sim2real each morning and summarize"
                </span>
                <span className="rounded-card border border-card bg-surface-canvas-alt px-1.5g py-1g text-left text-ui text-state-ink/60">
                  "Finish the σ ablation and find the seed-variance root cause"
                </span>
              </div>
            }
          />
          <EmptyState
            title="No tasks yet"
            description="Set a goal in chat and Cortex decomposes a queue with priority, deps and done-when."
            action={<Button variant="primary">+ Add task</Button>}
          />
          <EmptyState
            title="No threads yet"
            description="Complex work runs as multi-agent relay pipelines here — created on dispatch."
            action={<MonoText muted>!thread experiment-pipeline 〈goal〉</MonoText>}
          />
        </div>
      </section>

      <Group title="Overlays — Modal / Drawer / Toast / Popover (esc closes, focus trapped)">
        <OverlaysDemo />
      </Group>
    </div>
  );
}

function OverlaysDemo() {
  const { toast } = useToast();
  return (
    <>
      <Modal
        title="Task detail"
        description="Radix Dialog: focus is trapped while open, Esc closes, focus returns to the trigger."
        trigger={<Button variant="primary">Open Modal</Button>}
        footer={
          <ModalClose asChild>
            <Button variant="secondary">Close</Button>
          </ModalClose>
        }
      >
        <p>Body content on the white token surface. Try Tab / Shift-Tab and Esc.</p>
      </Modal>

      <Drawer
        title="Details drawer"
        description="Side sheet on Radix Dialog — slides in from the right, Esc closes."
        trigger={<Button variant="secondary">Open Drawer</Button>}
        footer={
          <DrawerClose asChild>
            <Button variant="secondary">Close</Button>
          </DrawerClose>
        }
      >
        <p>Full-height drawer content. Same a11y as Modal.</p>
      </Drawer>

      <Button
        variant="secondary"
        onClick={() =>
          toast({
            title: 'Task completed',
            description: 'c407 moved open → done',
            tone: 'done',
          })
        }
      >
        Fire Toast
      </Button>

      <Popover
        trigger={<Button variant="secondary">Open Popover</Button>}
      >
        <div className="flex flex-col gap-1g">
          <MonoText>popover content</MonoText>
          <p className="text-state-ink/70">Positioned by Radix; Esc closes, focus returns.</p>
        </div>
      </Popover>
    </>
  );
}
