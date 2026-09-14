// input:  @platform/adapter.js (@platform/types.js)
// output: CommandActionRouter — action routing + session state for interactive ! commands
// pos:    bridge between PlatformAdapter onAction/onModalSubmit and command handlers
//         Separate concern from interaction-handlers.ts (AskUserQuestion / ExitPlanMode)

import type { PlatformAdapter, ActionContext, ModalSubmitContext, MessageRef } from '@platform/index.js';

// --- Session state ---

export interface CommandSession {
  commandName: string;
  channel: string;
  messageRef?: MessageRef;
  data: Record<string, unknown>;
  createdAt: number;
}

// --- Registration types ---

export interface ActionBinding {
  actionId: string;
  handler: (ctx: ActionContext) => Promise<void>;
}

export interface ModalBinding {
  callbackId: string;
  handler: (ctx: ModalSubmitContext) => Promise<void>;
}

const NAMESPACE_PREFIX = 'cmd:';

// --- Router ---

export class CommandActionRouter {
  private actionHandlers = new Map<string, (ctx: ActionContext) => Promise<void>>();
  private modalHandlers = new Map<string, (ctx: ModalSubmitContext) => Promise<void>>();
  private sessions = new Map<string, CommandSession>();
  private _adapter: PlatformAdapter | null = null;
  private _bound = false;

  getAdapter(): PlatformAdapter | null {
    return this._adapter;
  }

  /**
   * Register all actions and modals for a single command.
   * Action IDs are automatically qualified with "cmd:<commandName>:" to avoid collisions
   * with other subsystems (ask_user_question_*, hook_plan_*).
   * Throws on duplicate actionId or callbackId.
   */
  registerCommand(commandName: string, config: {
    actions?: ActionBinding[];
    modals?: ModalBinding[];
  }): void {
    for (const a of config.actions ?? []) {
      const qualifiedId = `${NAMESPACE_PREFIX}${commandName}:${a.actionId}`;
      if (this.actionHandlers.has(qualifiedId)) {
        throw new Error(
          `CommandActionRouter: duplicate actionId "${qualifiedId}" for command "${commandName}"`
        );
      }
      this.actionHandlers.set(qualifiedId, a.handler);
    }
    for (const m of config.modals ?? []) {
      if (this.modalHandlers.has(m.callbackId)) {
        throw new Error(
          `CommandActionRouter: duplicate callbackId "${m.callbackId}" for command "${commandName}"`
        );
      }
      this.modalHandlers.set(m.callbackId, m.handler);
    }
  }

  /**
   * Register all stored handlers with the platform adapter.
   * Called once during startup after all commands have registered their actions.
   */
  bindToAdapter(adapter: PlatformAdapter): void {
    if (this._bound) return; // idempotent
    this._adapter = adapter;
    for (const [actionId, handler] of this.actionHandlers) {
      adapter.onAction(actionId, handler);
    }
    for (const [callbackId, handler] of this.modalHandlers) {
      adapter.onModalSubmit(callbackId, handler);
    }
    this._bound = true;
  }

  // --- Session state management ---

  /** Generate a session key and store state. Returns the key for use as action value. */
  createSession(
    channel: string,
    commandName: string,
    data: Record<string, unknown>,
    messageRef?: MessageRef,
  ): string {
    const key = `${channel}:${commandName}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    this.sessions.set(key, {
      commandName,
      channel,
      messageRef,
      data,
      createdAt: Date.now(),
    });
    // Auto-expire after 30 minutes
    setTimeout(() => this.sessions.delete(key), 30 * 60 * 1000).unref();
    return key;
  }

  getSession(key: string): CommandSession | undefined {
    return this.sessions.get(key);
  }

  deleteSession(key: string): void {
    this.sessions.delete(key);
  }

  /** Look up all sessions for a given channel (for cleanup on !new). */
  getSessionsByChannel(channel: string): CommandSession[] {
    const result: CommandSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.channel === channel) result.push(session);
    }
    return result;
  }

  /** Clear all sessions for a channel (e.g., on !new). */
  clearChannelSessions(channel: string): void {
    for (const [key, session] of this.sessions) {
      if (session.channel === channel) this.sessions.delete(key);
    }
  }
}
