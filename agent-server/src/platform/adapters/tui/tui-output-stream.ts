// input:  OutputStream interface, TuiConnection, protocol types
// output: TUI stream with full subagent-prompt display capability
// pos:    TUI adapter — no coalescing, client groups by streamId
// >>> If I am updated, update the folder's CORTEX.md <<<

import type { OutputStream, MutableRegion } from '../../output-stream.js';
import type { MessageRef, RichBlock, ActionElement, Destination } from '../../types.js';
import type { TuiConnection } from './tui-connection.js';
import { createLogger } from '@core/log.js';

const log = createLogger('tui-out');

let _streamIdCounter = 0;
function nextStreamId(): string {
  return `s${++_streamIdCounter}`;
}

function nextRegionId(): string {
  return `r${_streamIdCounter}-${Date.now().toString(36)}`;
}

export class TuiOutputStream implements OutputStream {
  readonly showFullSubagentPrompts = true;
  private conn: TuiConnection;
  private streamId: string;
  private seq: number;
  private parentRef: MessageRef | null = null;
  readonly refs: MessageRef[] = [];
  private destination: Destination;
  /** Adapter reference for posting messages through outbound methods */
  private adapter: { postMessage(dest: Destination, content: { text: string; richBlocks?: RichBlock[] }): Promise<MessageRef>; postInteractive(dest: Destination, content: { text: string; richBlocks?: RichBlock[]; actions: ActionElement[] }): Promise<MessageRef> };

  constructor(
    conn: TuiConnection,
    destination: Destination,
    adapter: { postMessage(dest: Destination, content: { text: string; richBlocks?: RichBlock[] }): Promise<MessageRef>; postInteractive(dest: Destination, content: { text: string; richBlocks?: RichBlock[]; actions: ActionElement[] }): Promise<MessageRef> },
    opts?: { threadId?: string | null },
  ) {
    this.conn = conn;
    this.streamId = nextStreamId();
    this.seq = 0;
    this.destination = destination;
    this.adapter = adapter;
  }

  private _nextSeq(): number {
    return ++this.seq;
  }

  emitText(text: string): void {
    if (!text?.trim()) return;
    this.conn.send({
      type: 'stream.text',
      streamId: this.streamId,
      text,
      seq: this._nextSeq(),
    });
  }

  openMutable(text: string): MutableRegion {
    if (!text?.trim()) return { update: () => {} };
    const regionId = nextRegionId();
    this.conn.send({
      type: 'stream.mutableOpen',
      streamId: this.streamId,
      regionId,
      text,
      seq: this._nextSeq(),
    });
    const sId = this.streamId;
    const rId = regionId;
    const conn = this.conn;
    return {
      update: (t: string) => {
        if (!t?.trim()) return;
        conn.send({
          type: 'stream.mutableUpdate',
          streamId: sId,
          regionId: rId,
          text: t,
          seq: this._nextSeq(),
        });
      },
    };
  }

  async postInteractive(text: string, opts?: { richBlocks?: RichBlock[]; actions?: ActionElement[] }): Promise<MessageRef | null> {
    const actions = opts?.actions;
    if (actions && actions.length > 0) {
      const ref = await this.adapter.postInteractive(this.destination, { text, richBlocks: opts?.richBlocks, actions });
      this.refs.push(ref);
      if (!this.parentRef) this.parentRef = ref;
      return ref;
    }
    const ref = await this.adapter.postMessage(this.destination, { text, richBlocks: opts?.richBlocks });
    this.refs.push(ref);
    if (!this.parentRef) this.parentRef = ref;
    return ref;
  }

  async flush(): Promise<void> {
    this.conn.send({
      type: 'stream.flush',
      streamId: this.streamId,
      seq: this._nextSeq(),
    });
  }

  getRefs(): MessageRef[] {
    return [...this.refs];
  }

  getParentRef(): MessageRef | null {
    return this.parentRef;
  }
}
