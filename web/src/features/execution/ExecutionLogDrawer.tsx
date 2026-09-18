import * as RadixDialog from '@radix-ui/react-dialog';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { useToast } from '@/design';
import { LogDrawerView } from './LogDrawerView';
import { execMeta, execNow, execPill, isStoppable } from './execution-log-view';

// Execution drawer (design 09-exec-logs, prototype.dc.html L1542–1562) — a right dark slide-over
// reproduced 1:1 from the prototype. Built on Radix Dialog for a11y (focus trap, Esc-close,
// focus-restore) + the shared backdrop scrim (prototype L1292). Wired to real tRPC data:
// executions.get (header + meta) and executions.cancel (Kill run). Replaces the old 8b execution
// detail page (task 2198). Opened from any dispatch row via the ExecutionLogDrawerProvider. The
// 1:1 chrome lives in LogDrawerView (pure).
//
// The live log pane went away with cortex-run: its output.log was the only tailable source, so
// after the removal nothing could ever fill it (see docs/waitpoints.md for the replacement path).

const DRAWER_STYLE: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  right: 0,
  bottom: 0,
  width: 480,
  background: 'var(--proto-ink)',
  zIndex: 61,
  display: 'flex',
  flexDirection: 'column',
  boxShadow: 'var(--shadow-drawer)',
};

const BACKDROP_STYLE: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'var(--overlay-scrim)',
  zIndex: 60,
};

// Visually-hidden Radix Title — satisfies Dialog a11y without disturbing the 1:1 layout.
const SR_ONLY: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

export interface ExecutionLogDrawerProps {
  executionId: string | null;
  onClose: () => void;
}

export function ExecutionLogDrawer({ executionId, onClose }: ExecutionLogDrawerProps) {
  const L = useVocab();
  const open = executionId != null;
  return (
    <RadixDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay
          style={BACKDROP_STYLE}
          className="animate-cxfade motion-reduce:animate-none"
        />
        <RadixDialog.Content
          aria-describedby={undefined}
          style={DRAWER_STYLE}
          className="animate-cxdrawer focus:outline-none motion-reduce:animate-none"
        >
          <RadixDialog.Title style={SR_ONLY}>
            {executionId ? `${L.exLogTitle} ${executionId}` : L.exLogTitle}
          </RadixDialog.Title>
          {open ? <DrawerBody executionId={executionId} onClose={onClose} /> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

function DrawerBody({ executionId, onClose }: { executionId: string; onClose: () => void }) {
  const trpc = useTRPC();
  const L = useVocab();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // No execution.* lifecycle bus event exists — poll while running so the header pill/meta
  // reflect a cancel.
  const execQuery = useQuery(
    trpc.executions.get.queryOptions(
      { executionId },
      { refetchInterval: (q) => (q.state.data?.status === 'running' ? 3000 : false) },
    ),
  );
  const detail = execQuery.data;

  const cancel = useMutation(
    trpc.executions.cancel.mutationOptions({
      onSettled: () =>
        queryClient.invalidateQueries(trpc.executions.get.queryFilter({ executionId })),
    }),
  );

  const onKill = () => {
    if (!detail || !isStoppable(detail.status)) {
      toast({ title: `${executionId} ${L.exAlreadyFinished}`, tone: 'cancelled' });
      return;
    }
    cancel.mutate(
      { executionId },
      {
        onSuccess: (res) => {
          if (res.cancelled) toast({ title: `${executionId} ${L.exKilled}`, tone: 'failed' });
        },
      },
    );
  };

  return (
    <LogDrawerView
      title={detail?.id ?? executionId}
      pill={detail ? execPill(detail.status) : null}
      meta={detail ? execMeta(detail) : ''}
      now={detail ? execNow(detail) : ''}
      notice={L.exNoLiveLog}
      killDisabled={cancel.isPending}
      onKill={onKill}
      onClose={onClose}
    />
  );
}
