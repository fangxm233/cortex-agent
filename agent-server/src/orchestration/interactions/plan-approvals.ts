// input:  EventBus
// output: PlanApprovals singleton — unified requestId-keyed plan approval state + PendingPlan type
// pos:    orch/interactions/ layer, merges pendingPlans + pendingHookPlans, publishes plan.approved
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { EventBus } from '@events/index.js';

export interface PendingPlan {
  channel: string;
  machine?: string;
  localPlanPath?: string;
  taskPlanPath?: string | null;
  sessionName?: string | null;
  executionId?: string | null;
  sessionId?: string | null;
  /** PI extension_ui_request id — when set, plan approval routes through sendExtensionUiResponse instead of spawning a new turn. */
  extensionUiId?: string | null;
  threadId?: string | null;
}

export class PlanApprovals {
  private _map = new Map<string, PendingPlan>();
  private _bus: EventBus | null = null;

  constructor(bus?: EventBus) {
    if (bus) this._bus = bus;
  }

  setBus(bus: EventBus): void {
    this._bus = bus;
  }

  /**
   * Register a pending plan for a requestId.
   * Does NOT publish plan.submitted — that is already done by hook-bridge before
   * this is called (from the bus.subscribe('plan.submitted') handler in app.ts).
   */
  register(requestId: string, plan: PendingPlan): void {
    this._map.set(requestId, plan);
  }

  /** Lookup a pending plan by requestId without removing it. */
  lookup(requestId: string): PendingPlan | undefined {
    return this._map.get(requestId);
  }

  /**
   * Resolve a pending plan (approval path).
   * Removes the entry and publishes plan.approved.
   * Returns the plan or undefined if not found.
   */
  resolve(requestId: string): PendingPlan | undefined {
    const plan = this._map.get(requestId);
    if (!plan) return undefined;
    this._map.delete(requestId);
    if (this._bus) {
      this._bus.publish({
        type: 'plan.approved',
        channel: plan.channel,
        executionId: plan.executionId ?? '',
      });
    }
    return plan;
  }

  /**
   * Reject a pending plan (feedback / !new path).
   * Removes the entry without publishing any event.
   * Returns the plan or undefined if not found.
   */
  reject(requestId: string): PendingPlan | undefined {
    const plan = this._map.get(requestId);
    if (!plan) return undefined;
    this._map.delete(requestId);
    return plan;
  }

  /** Return the first pending plan for a channel, or null. */
  getByChannel(channel: string): { requestId: string; plan: PendingPlan } | null {
    for (const [requestId, plan] of this._map) {
      if (plan.channel === channel) return { requestId, plan };
    }
    return null;
  }

  /** Returns true if a pending plan is registered for the requestId. */
  has(requestId: string): boolean {
    return this._map.has(requestId);
  }

  /**
   * Clear all pending plans for a given channel (called by !new).
   * Returns the number of entries removed.
   */
  clearByChannel(channel: string): number {
    let count = 0;
    for (const [requestId, plan] of this._map) {
      if (plan.channel === channel) {
        this._map.delete(requestId);
        count++;
      }
    }
    return count;
  }
}

export const planApprovals = new PlanApprovals();
