import type { PlatformAdapter, IncomingMessage } from '@platform/index.js';
import { agentRunner } from './agent-runner.js';
import { threadExecutor } from './thread-executor.js';

export interface OrchMessageContext {
  message: IncomingMessage;
  channel: string;
  adapter: PlatformAdapter;
  threadAnchorId: string | null;
  hasFiles: boolean;
  userMessage: string;
  agentMessage: string;
  threadAddMatch: RegExpMatchArray | null;
  threadStartMatch: RegExpMatchArray | null;
  existingThread: any;
  isActiveThread: boolean;
}

type Runner = { route(ctx: any): Promise<void> };

export class Orchestrator {
  private _agentRunner: Runner;
  private _threadExecutor: Runner;

  constructor(deps?: { agentRunner?: Runner; threadExecutor?: Runner }) {
    this._agentRunner = deps?.agentRunner ?? agentRunner;
    this._threadExecutor = deps?.threadExecutor ?? threadExecutor;
  }

  /** Two-branch routing decision: thread-match path or default-agent path. */
  async handleMessage(ctx: OrchMessageContext): Promise<void> {
    const { threadAddMatch, threadStartMatch, isActiveThread } = ctx;
    if (threadAddMatch || threadStartMatch || isActiveThread) {
      await this._threadExecutor.route(ctx);
    } else {
      await this._agentRunner.route(ctx);
    }
  }
}

export const orchestrator = new Orchestrator();
