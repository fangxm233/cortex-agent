import type { EventBus } from '@events/event-bus.js';
import { countFeature, recordUiMutation } from './usage.js';

/** Fold the event bus's feature signals into the daily rollup. Returns the unsubscribe. */
export function subscribeTelemetryToBus(bus: EventBus): () => void {
  const unsubscribers = [
    bus.subscribe('ui.mutate-invoked', (event) => recordUiMutation(event.op, event.result?.ok === true, event.client)),
    bus.subscribe('plan.submitted', (event) => { if (!event.dryRun) countFeature('plan_submitted'); }),
    bus.subscribe('ask-user.requested', (event) => { if (!event.dryRun) countFeature('ask_user_asked'); }),
    bus.subscribe('ask-user.answered', () => countFeature('ask_user_answered')),
    bus.subscribe('session.interaction', (event) => {
      if (event.kind !== 'plan-approval') return;
      if (event.status === 'approved') countFeature('plan_approved');
      if (event.status === 'rejected') countFeature('plan_rejected');
    }),
  ];
  return () => { for (const subscription of unsubscribers) subscription.unsubscribe(); };
}
