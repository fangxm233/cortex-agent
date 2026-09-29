import type { PlatformAdapter, ActionContext, ModalSubmitContext } from '@platform/index.js';

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
}
