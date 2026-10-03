import type { PlatformAdapter, IncomingMessage } from '@platform/index.js';
import { agentRunner } from './agent-runner.js';

export interface OrchMessageContext {
  message: IncomingMessage;
  channel: string;
  adapter: PlatformAdapter;
  threadAnchorId: string | null;
  hasFiles: boolean;
  userMessage: string;
  agentMessage: string;
}

type Runner = { route(ctx: any): Promise<void> };

export class Orchestrator {
  private _agentRunner: Runner;

  constructor(deps?: { agentRunner?: Runner }) {
    this._agentRunner = deps?.agentRunner ?? agentRunner;
  }

  /** Every inbound message that is not a command opens (or joins) a conversation turn. */
  async handleMessage(ctx: OrchMessageContext): Promise<void> {
    await this._agentRunner.route(ctx);
  }
}

export const orchestrator = new Orchestrator();
