// input:  ./types.js platform-agnostic message types
// output: PlatformAdapter interface with symmetric queue-marker lifecycle
// pos:    Boundary between orchestration and messaging platforms
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type {
  MessageRef,
  MessageContent,
  MessageContext,
  MessageEditContext,
  ActionContext,
  ModalSubmitContext,
  ModalDefinition,
  PlatformCapabilities,
  PlatformFileRef,
  DownloadedFile,
  Destination,
  PostMessageOpts,
  FileUploadOpts,
  RichBlock,
  ActionElement,
} from './types.js';
import type { OutputStream, OpenOutputStreamOpts } from './output-stream.js';

export interface PlatformAdapter {
  readonly name: string;
  readonly capabilities: PlatformCapabilities;

  // --- Lifecycle ---
  start(): Promise<void>;
  stop(): Promise<void>;

  // --- Event registration ---
  onMessage(handler: (ctx: MessageContext) => Promise<void>): void;
  onMessageEdit(handler: (ctx: MessageEditContext) => Promise<void>): void;
  onAction(actionId: string, handler: (ctx: ActionContext) => Promise<void>): void;
  onModalSubmit(callbackId: string, handler: (ctx: ModalSubmitContext) => Promise<void>): void;

  // --- Outbound messaging ---
  postMessage(destination: Destination, content: MessageContent, opts?: PostMessageOpts): Promise<MessageRef>;
  updateMessage(ref: MessageRef, content: MessageContent): Promise<void>;
  deleteMessage(ref: MessageRef): Promise<void>;

  // --- Interactive messages (buttons, actions) ---
  postInteractive(destination: Destination, content: MessageContent & {
    actions: ActionElement[];
  }, opts?: PostMessageOpts): Promise<MessageRef>;

  // --- Modals ---
  openModal(triggerId: string, modal: ModalDefinition): Promise<void>;

  // --- Queue backpressure ---
  /** Mark an inbound message as waiting behind work already in flight (⏳). */
  markQueued(ref: MessageRef): Promise<void>;
  /** Retire that marker once the message has been consumed, leaving a ✅ in its place. */
  unmarkQueued(ref: MessageRef): Promise<void>;

  // --- Files ---
  uploadFile(destination: Destination, filePath: string, opts?: FileUploadOpts): Promise<void>;
  downloadFile(fileRef: PlatformFileRef, destDir: string): Promise<DownloadedFile>;

  // --- Misc ---
  getPermalink(ref: MessageRef): Promise<string | null>;

  // --- Output streams ---

  /** Open a new OutputStream for streaming agent output to the given destination. */
  openOutputStream(destination: Destination, opts?: OpenOutputStreamOpts): OutputStream;

  // --- Project conduit mapping ---

  /** Register a conduit (channel/chat) for project-report destinations. */
  bindProjectConduit(projectId: string, conduitHint: string): Promise<void>;

  /** Remove a conduit registration. */
  unbindProjectConduit(projectId: string): Promise<void>;

  /** Get all registered project→conduit mappings. */
  getProjectConduits(): Promise<Record<string, string>>;

  /** Inverse lookup: given an inbound conduit (e.g., a Slack channel id), return
   *  the project it is currently bound to, or null if unbound. Used by the
   *  orchestration layer to attach inbound messages to their project. */
  resolveInboundProject(conduit: string): Promise<string | null>;

  /** True if the given (prefixed) conduit belongs to this adapter. Used by
   *  CompositeAdapter to route outbound operations to the right sub-adapter when
   *  multiple platforms are online simultaneously. Each adapter owns a conduit
   *  namespace by prefix: Slack `slack:`, Feishu `feishu:`, TUI `tui-`/`tui:`. */
  ownsConduit(conduit: string): boolean;
}
