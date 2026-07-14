// input:  nothing (pure types module)
// output: Platform-independent message/block/modal type family
// pos:    Type foundation of the Platform abstraction
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// --- Message Identity ---

/** Universal reference to a message on any platform.
 *  Replaces the Slack-specific (channel, ts, thread_ts) triplet. */
export interface MessageRef {
  /** Adapter-defined conduit identifier (Slack channel id; Feishu chat_id; TUI synthetic connection id) */
  conduit: string;
  messageId: string;
  threadId?: string;
  /** For composite (multi-platform) posts: the per-adapter sub-refs that this ref aggregates.
   *  Each entry carries that platform's own conduit + messageId, so a downstream consumer can
   *  pick the anchor that belongs to a given platform (messageIds are platform-specific:
   *  a Slack ts is not a valid Feishu open_message_id). Absent for single-adapter refs. */
  parts?: MessageRef[];
}

// --- Inbound Types ---

/** senderId used by internally synthesized wake/callback messages (thread-callback wakeSession).
 *  Consumers that intercept HUMAN input on a channel (e.g. the manager-qa human-answer backstop)
 *  must skip messages carrying this sender — a synthetic notice is never a human reply. */
export const SYNTHETIC_CALLBACK_SENDER = 'cortex-thread-callback';

export interface IncomingMessage {
  ref: MessageRef;
  text: string;
  senderId: string;
  isBot: boolean;
  files?: PlatformFileRef[];
  attachments?: IncomingAttachment[];
  /** Pre-uploaded file attachments from the web UI (paths already on disk). */
  webAttachments?: { name: string; path: string; size: number; mimeType: string; type: 'image' | 'video' | 'file' }[];
  kind: 'user' | 'system' | 'file_share';
  raw: unknown;
}

export interface IncomingAttachment {
  authorName?: string;
  text?: string;
  url?: string;
  isForwarded: boolean;
}

export interface PlatformFileRef {
  id: string;
  name: string;
  mimetype: string;
  url: string;
  /** Prefixed conduit the file originated from (e.g. `slack:C0xxx`, `feishu:oc_xxx`,
   *  `tui-xxxx`). Lets CompositeAdapter route downloadFile to the owning adapter
   *  when multiple platforms are online. Optional for back-compat. */
  conduit?: string;
  raw: unknown;
}

export interface DownloadedFile {
  localPath: string;
  mimetype: string;
  name: string;
}

// --- Outbound Content ---

export interface MessageContent {
  text: string;
  richBlocks?: RichBlock[];
}

export type RichBlock =
  | { type: 'markdown'; text: string }
  | { type: 'section'; text: string; format?: 'plain' | 'markdown' }
  | { type: 'context'; text: string }
  | { type: 'divider' }
  | { type: 'actions'; elements: ActionElement[] };

export type ActionElement = ButtonElement;

export interface ButtonElement {
  type: 'button';
  text: string;
  actionId: string;
  value: string;
  style?: 'primary' | 'danger';
}

// --- Modal Types ---

export interface ModalDefinition {
  callbackId: string;
  title: string;
  submitLabel?: string;
  closeLabel?: string;
  privateMetadata?: string;
  fields: ModalField[];
}

export type ModalField =
  | ModalSelectField
  | ModalMultiSelectField
  | ModalTextInputField
  | ModalSectionField;

export interface ModalSelectField {
  type: 'select';
  blockId: string;
  label: string;
  actionId: string;
  placeholder?: string;
  options: SelectOption[];
  optional?: boolean;
}

export interface ModalMultiSelectField {
  type: 'multi_select';
  blockId: string;
  label: string;
  actionId: string;
  placeholder?: string;
  options: SelectOption[];
  optional?: boolean;
}

export interface ModalTextInputField {
  type: 'text_input';
  blockId: string;
  label: string;
  actionId: string;
  placeholder?: string;
  multiline?: boolean;
  optional?: boolean;
}

export interface ModalSectionField {
  type: 'section';
  text: string;
}

export interface SelectOption {
  label: string;
  value: string;
}

// --- Modal Submit Values ---

export interface ModalFieldValue {
  selectedOption?: { value: string };
  selectedOptions?: { value: string }[];
  value?: string;
}

// --- Event Contexts ---

export interface MessageContext {
  message: IncomingMessage;
  reply(content: MessageContent, opts?: { threadId?: string }): Promise<MessageRef>;
}

export interface MessageEditContext {
  originalRef: MessageRef;
  newText: string;
  raw: unknown;
}

export interface ActionContext {
  actionId: string;
  value: string;
  triggerId: string;
  messageRef?: MessageRef;
  userId: string;
  channelId: string;
}

export interface ModalSubmitContext {
  callbackId: string;
  privateMetadata: string;
  values: Record<string, Record<string, ModalFieldValue>>;
  userId: string;
  ack(response?: { errors?: Record<string, string> }): Promise<void>;
}

// --- Platform Capabilities ---

export interface PlatformCapabilities {
  threads: boolean;
  messageEdit: boolean;
  modals: boolean;
  reactions: boolean;
  fileUpload: boolean;
  richFormatting: boolean;
  maxMessageLength: number;
  maxThreadDepth: number;
}

// --- Destination (outbound addressing) ---

/** Declared intent for where and why a message is sent.
 *  Replaces raw `channel: string` in outbound adapter methods.
 *  - interactive-reply: reply in an ongoing conversation (conduit = channel)
 *  - project-report:   push a report to a project's channel
 *  - system-notice:    send to the platform-configured admin channel */
export type Destination =
  | { type: 'interactive-reply'; conduit: string; sessionId?: string }
  | { type: 'project-report'; projectId: string; trigger: string; sessionId?: string }
  | { type: 'system-notice' };

/** Resolve a Destination to a concrete channel string for the adapter.
 *  `adminChannel` is required for `system-notice` and ignored for other types. */
export function resolveDestinationConduit(dest: Destination, adminChannel?: string): string {
  switch (dest.type) {
    case 'interactive-reply':
      return dest.conduit;
    case 'project-report':
      // FIXME: resolve projectId → channel via project store when the routing
      // layer is added in the M3/M4 outbound refactoring.
      return dest.projectId;
    case 'system-notice':
      if (!adminChannel) {
        throw new Error('system-notice destination requires a configured admin channel');
      }
      return adminChannel;
  }
}

// --- Post Options ---

export interface PostMessageOpts {
  threadId?: string;
}

export interface FileUploadOpts {
  filename?: string;
  comment?: string;
  threadId?: string;
}

// --- Durable Message Hooks ---

export interface DurableHooks {
  beforePost(destination: Destination, text: string, opts?: { threadId?: string; richBlocks?: RichBlock[] }): Promise<string>;
  beforeUpdate(channel: string, messageId: string, text: string, opts?: { richBlocks?: RichBlock[] }): Promise<string>;
  afterSent(walId: string, slackTs?: string): Promise<void>;
  /** Release the in-flight claim when the inline send path fails permanently.
   *  This allows the drain loop to retry delivery. */
  onSendFailed?(walId: string): void;
}
