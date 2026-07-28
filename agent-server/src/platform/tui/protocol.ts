// input:  platform message and interaction types
// output: TuiFrame union, type guards, parseFrame, and encodeFrame
// pos:    TUI gateway/client wire protocol contract
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
//
// Conventions:
//   - Discriminator format: lowercase namespace + dot + camelCase verb
//     (e.g. 'chat.markQueued', 'stream.mutableOpen', 'ui.queryResult')
//   - Every server→client frame carries `seq: number` for ordering / dedup,
//     except `pong` (keepalive) and `error` (out-of-band control).
//   - Every client→server REQUEST frame carries `id: string` for correlation,
//     except `handshake.hello` (first frame, no prior context), `ping`, `close`.
//   - Response frames echo the request `id` AND carry their own server `seq`.

import type {
  MessageRef, MessageContent, RichBlock, ActionElement,
  ModalDefinition, ModalFieldValue,
} from '../types.js';

// ── Protocol Version ──

export const PROTOCOL_VERSION = 1;

// ── Discriminator String Constants ──

// Lifecycle
export const HANDSHAKE_HELLO       = 'handshake.hello';        // C→S
export const HANDSHAKE_ACK         = 'handshake.ack';          // S→C
export const SESSION_SWITCH        = 'session.switch';         // C→S
export const SESSION_SWITCHED      = 'session.switched';       // S→C
export const PING                  = 'ping';                   // both
export const PONG                  = 'pong';                   // both
export const CLOSE                 = 'close';                  // C→S
// Chat outbound (S→C)
export const CHAT_POST             = 'chat.post';
export const CHAT_UPDATE           = 'chat.update';
export const CHAT_DELETE           = 'chat.delete';
export const CHAT_MARK_QUEUED      = 'chat.markQueued';
// Chat inbound (C→S)
export const MSG_USER              = 'msg.user';
export const MSG_EDIT              = 'msg.edit';
// Streaming (S→C)
export const STREAM_TEXT           = 'stream.text';
export const STREAM_MUTABLE_OPEN   = 'stream.mutableOpen';
export const STREAM_MUTABLE_UPDATE = 'stream.mutableUpdate';
export const STREAM_FLUSH          = 'stream.flush';
// Interactive (S→C: interactive.post, modal.open, modal.ack; C→S: action.click, modal.submit)
export const INTERACTIVE_POST      = 'interactive.post';
export const MODAL_OPEN            = 'modal.open';
export const MODAL_ACK             = 'modal.ack';
export const ACTION_CLICK          = 'action.click';
export const MODAL_SUBMIT          = 'modal.submit';
// Other (S→C)
export const TRANSCRIPT_REPLAY     = 'transcript.replay';
export const NOTIFICATION          = 'notification';
// UI side-channel
export const UI_QUERY              = 'ui.query';               // C→S
export const UI_QUERY_RESULT       = 'ui.queryResult';         // S→C
export const UI_MUTATE             = 'ui.mutate';              // C→S
export const UI_MUTATE_RESULT      = 'ui.mutateResult';        // S→C
export const UI_SUBSCRIBE          = 'ui.subscribe';           // C→S
export const UI_EVENT              = 'ui.event';               // S→C
export const UI_UNSUBSCRIBE        = 'ui.unsubscribe';         // C→S
// Error (S→C)
export const ERROR                 = 'error';

// ── TuiFrame Variants ──

// --- Lifecycle ---

/** @direction client→server (first frame after WS open) */
export interface HandshakeHello {
  type: typeof HANDSHAKE_HELLO;
  protocolVersion: number;
  clientName: string;
  clientVersion: string;
  resume?: { sessionId: string } | null;
  project?: string | null;
}

/** @direction server→client (response to handshake.hello) */
export interface HandshakeAck {
  type: typeof HANDSHAKE_ACK;
  protocolVersion: number;
  serverVersion: string;
  conduitId: string;
  defaultProjectId: string;
  seq: number;
}

/** @direction client→server (switch active session — fresh or attach existing) */
export interface SessionSwitch {
  type: typeof SESSION_SWITCH;
  id: string;
  projectId: string;
  /** null = create fresh session in projectId */
  sessionId?: string | null;
}

/** @direction server→client (result of session.switch — id echoes request) */
export interface SessionSwitched {
  type: typeof SESSION_SWITCHED;
  id: string;
  projectId: string;
  sessionId: string;
  sessionName: string;
  isFresh: boolean;
  seq: number;
}

/** @direction both (keepalive) */
export interface Ping {
  type: typeof PING;
  ts: number;
}

/** @direction both (keepalive — no seq; out-of-band) */
export interface Pong {
  type: typeof PONG;
  ts: number;
}

/** @direction client→server (explicit close; also fires implicitly on WS close) */
export interface Close {
  type: typeof CLOSE;
  reason?: string;
}

// --- Chat outbound (S→C) ---

/** @direction server→client (post a new message into the conduit's transcript) */
export interface ChatPost {
  type: typeof CHAT_POST;
  ref: MessageRef;
  content: MessageContent;
  threadAnchorId?: string | null;
  seq: number;
}

/** @direction server→client (update an existing message by ref) */
export interface ChatUpdate {
  type: typeof CHAT_UPDATE;
  ref: MessageRef;
  content: MessageContent;
  seq: number;
}

/** @direction server→client (delete a message by ref) */
export interface ChatDelete {
  type: typeof CHAT_DELETE;
  ref: MessageRef;
  seq: number;
}

/** @direction server→client (inline backpressure marker — replaces Slack's hourglass) */
export interface ChatMarkQueued {
  type: typeof CHAT_MARK_QUEUED;
  ref: MessageRef;
  seq: number;
}

// --- Chat inbound (C→S) ---

/** @direction client→server (user submits a message in the active session) */
export interface MsgUser {
  type: typeof MSG_USER;
  id: string;
  text: string;
  threadAnchorId?: string | null;
  attachments?: Array<{ path: string; mimeType: string; name: string }>;
}

/** @direction client→server (rare: user edits a previously sent message) */
export interface MsgEdit {
  type: typeof MSG_EDIT;
  id: string;
  ref: MessageRef;
  newText: string;
}

// --- Streaming (S→C) ---

/** @direction server→client (commit a text segment to a stream) */
export interface StreamText {
  type: typeof STREAM_TEXT;
  streamId: string;
  text: string;
  seq: number;
}

/** @direction server→client (open a fresh mutable region inside a stream) */
export interface StreamMutableOpen {
  type: typeof STREAM_MUTABLE_OPEN;
  streamId: string;
  regionId: string;
  text: string;
  seq: number;
}

/** @direction server→client (replace a mutable region's content) */
export interface StreamMutableUpdate {
  type: typeof STREAM_MUTABLE_UPDATE;
  streamId: string;
  regionId: string;
  text: string;
  seq: number;
}

/** @direction server→client (optional flush marker — used by tests for ordering) */
export interface StreamFlush {
  type: typeof STREAM_FLUSH;
  streamId: string;
  seq: number;
}

// --- Interactive ---

/** @direction server→client (post a message with action buttons) */
export interface InteractivePost {
  type: typeof INTERACTIVE_POST;
  ref: MessageRef;
  content: MessageContent;
  actions: ActionElement[];
  threadAnchorId?: string | null;
  seq: number;
}

/** @direction server→client (ask client to open a modal — AskUserQuestion / plan feedback) */
export interface ModalOpen {
  type: typeof MODAL_OPEN;
  triggerId: string;
  modal: ModalDefinition;
  seq: number;
}

/** @direction server→client (ack a modal submission; id echoes modal.submit) */
export interface ModalAck {
  type: typeof MODAL_ACK;
  id: string;
  errors?: Record<string, string>;
  seq: number;
}

/** @direction client→server (user clicked an action button) */
export interface ActionClick {
  type: typeof ACTION_CLICK;
  id: string;
  actionId: string;
  value: string;
  triggerId: string;
  messageRef?: MessageRef;
  userId: string;
}

/** @direction client→server (user submitted a modal — values match ModalSubmitContext.values) */
export interface ModalSubmit {
  type: typeof MODAL_SUBMIT;
  id: string;
  callbackId: string;
  privateMetadata: string;
  values: Record<string, Record<string, ModalFieldValue>>;
  userId: string;
}

// --- Transcript replay (S→C) ---

/**
 * @direction server→client (replay prior messages on session attach)
 *
 * Items are wire frames the client renders identically to live frames;
 * they share the same seq space but are flagged via `isCatchUp` so the
 * client suppresses notification side effects.
 *
 * Outer envelope carries no own `seq` — clients should use `seqEnd` as
 * the high-water mark and expect the next live frame at `seqEnd + 1`.
 */
export interface TranscriptReplay {
  type: typeof TRANSCRIPT_REPLAY;
  sessionId: string;
  items: Array<ChatPost | ChatUpdate | InteractivePost>;
  seqStart: number;
  seqEnd: number;
  isCatchUp: boolean;
}

// --- Notification (S→C) ---

/**
 * @direction server→client
 *
 * Routed when a project-report / scheduled-report / thread-report destination
 * lands on a TUI conduit whose active session ≠ the originating session.
 * Renders as a corner badge, not inserted into the active chat.
 */
export interface Notification {
  type: typeof NOTIFICATION;
  kind: 'project-report' | 'system-notice' | 'thread-report';
  projectId: string;
  sessionId?: string | null;
  title: string;
  body: string;
  ref?: MessageRef;
  seq: number;
}

// --- UI side-channel ---

/** @direction client→server (read-only query into UiService) */
export interface UiQuery {
  type: typeof UI_QUERY;
  id: string;
  scope: string;
  params?: Record<string, unknown>;
}

/** @direction server→client (result of ui.query — id echoes request) */
export type UiQueryResult =
  | { type: typeof UI_QUERY_RESULT; id: string; ok: true; data: unknown }
  | { type: typeof UI_QUERY_RESULT; id: string; ok: false; error: { code: string; message: string } };

/** @direction client→server (audited write into UiService) */
export interface UiMutate {
  type: typeof UI_MUTATE;
  id: string;
  op: string;
  args: Record<string, unknown>;
}

/** @direction server→client (result of ui.mutate — id echoes request) */
export type UiMutateResult =
  | { type: typeof UI_MUTATE_RESULT; id: string; ok: true; data?: unknown }
  | { type: typeof UI_MUTATE_RESULT; id: string; ok: false; error: { code: string; message: string } };

/** @direction client→server (open an event subscription) */
export interface UiSubscribe {
  type: typeof UI_SUBSCRIBE;
  id: string;
  filter: { events: string[]; projectId?: string | null };
}

/** @direction server→client (streamed event for a subscription — id echoes subscribe) */
export interface UiEvent {
  type: typeof UI_EVENT;
  id: string;
  event: { type: string; ts: string; payload: unknown };
  seq: number;
}

/** @direction client→server (close a subscription — id matches subscribe) */
export interface UiUnsubscribe {
  type: typeof UI_UNSUBSCRIBE;
  id: string;
}

// --- Error (S→C, out-of-band control; no seq) ---

/** @direction server→client */
export interface ErrorFrame {
  type: typeof ERROR;
  code: number;
  message: string;
  /** id of the client→server frame that caused this error, if applicable */
  refId?: string;
  closeAfter?: boolean;
}

// ── Discriminated Union ──

export type TuiFrame =
  | HandshakeHello
  | HandshakeAck
  | SessionSwitch
  | SessionSwitched
  | Ping
  | Pong
  | Close
  | ChatPost
  | ChatUpdate
  | ChatDelete
  | ChatMarkQueued
  | MsgUser
  | MsgEdit
  | StreamText
  | StreamMutableOpen
  | StreamMutableUpdate
  | StreamFlush
  | InteractivePost
  | ModalOpen
  | ModalAck
  | ActionClick
  | ModalSubmit
  | TranscriptReplay
  | Notification
  | UiQuery
  | UiQueryResult
  | UiMutate
  | UiMutateResult
  | UiSubscribe
  | UiEvent
  | UiUnsubscribe
  | ErrorFrame;

// ── Guards ──

export function isHandshakeHello(f: TuiFrame): f is HandshakeHello { return f.type === HANDSHAKE_HELLO; }
export function isHandshakeAck(f: TuiFrame): f is HandshakeAck { return f.type === HANDSHAKE_ACK; }
export function isSessionSwitch(f: TuiFrame): f is SessionSwitch { return f.type === SESSION_SWITCH; }
export function isSessionSwitched(f: TuiFrame): f is SessionSwitched { return f.type === SESSION_SWITCHED; }
export function isPing(f: TuiFrame): f is Ping { return f.type === PING; }
export function isPong(f: TuiFrame): f is Pong { return f.type === PONG; }
export function isClose(f: TuiFrame): f is Close { return f.type === CLOSE; }
export function isChatPost(f: TuiFrame): f is ChatPost { return f.type === CHAT_POST; }
export function isChatUpdate(f: TuiFrame): f is ChatUpdate { return f.type === CHAT_UPDATE; }
export function isChatDelete(f: TuiFrame): f is ChatDelete { return f.type === CHAT_DELETE; }
export function isChatMarkQueued(f: TuiFrame): f is ChatMarkQueued { return f.type === CHAT_MARK_QUEUED; }
export function isMsgUser(f: TuiFrame): f is MsgUser { return f.type === MSG_USER; }
export function isMsgEdit(f: TuiFrame): f is MsgEdit { return f.type === MSG_EDIT; }
export function isStreamText(f: TuiFrame): f is StreamText { return f.type === STREAM_TEXT; }
export function isStreamMutableOpen(f: TuiFrame): f is StreamMutableOpen { return f.type === STREAM_MUTABLE_OPEN; }
export function isStreamMutableUpdate(f: TuiFrame): f is StreamMutableUpdate { return f.type === STREAM_MUTABLE_UPDATE; }
export function isStreamFlush(f: TuiFrame): f is StreamFlush { return f.type === STREAM_FLUSH; }
export function isInteractivePost(f: TuiFrame): f is InteractivePost { return f.type === INTERACTIVE_POST; }
export function isModalOpen(f: TuiFrame): f is ModalOpen { return f.type === MODAL_OPEN; }
export function isModalAck(f: TuiFrame): f is ModalAck { return f.type === MODAL_ACK; }
export function isActionClick(f: TuiFrame): f is ActionClick { return f.type === ACTION_CLICK; }
export function isModalSubmit(f: TuiFrame): f is ModalSubmit { return f.type === MODAL_SUBMIT; }
export function isTranscriptReplay(f: TuiFrame): f is TranscriptReplay { return f.type === TRANSCRIPT_REPLAY; }
export function isNotification(f: TuiFrame): f is Notification { return f.type === NOTIFICATION; }
export function isUiQuery(f: TuiFrame): f is UiQuery { return f.type === UI_QUERY; }
export function isUiQueryResult(f: TuiFrame): f is UiQueryResult { return f.type === UI_QUERY_RESULT; }
export function isUiMutate(f: TuiFrame): f is UiMutate { return f.type === UI_MUTATE; }
export function isUiMutateResult(f: TuiFrame): f is UiMutateResult { return f.type === UI_MUTATE_RESULT; }
export function isUiSubscribe(f: TuiFrame): f is UiSubscribe { return f.type === UI_SUBSCRIBE; }
export function isUiEvent(f: TuiFrame): f is UiEvent { return f.type === UI_EVENT; }
export function isUiUnsubscribe(f: TuiFrame): f is UiUnsubscribe { return f.type === UI_UNSUBSCRIBE; }
export function isErrorFrame(f: TuiFrame): f is ErrorFrame { return f.type === ERROR; }

// ── Required Fields (for parseFrame validation) ──

const REQUIRED_FIELDS: Record<string, readonly string[]> = {
  [HANDSHAKE_HELLO]:       ['protocolVersion', 'clientName', 'clientVersion'],
  [HANDSHAKE_ACK]:         ['protocolVersion', 'serverVersion', 'conduitId', 'defaultProjectId', 'seq'],
  [SESSION_SWITCH]:        ['id', 'projectId'],
  [SESSION_SWITCHED]:      ['id', 'projectId', 'sessionId', 'sessionName', 'isFresh', 'seq'],
  [PING]:                  ['ts'],
  [PONG]:                  ['ts'],
  [CLOSE]:                 [],
  [CHAT_POST]:             ['ref', 'content', 'seq'],
  [CHAT_UPDATE]:           ['ref', 'content', 'seq'],
  [CHAT_DELETE]:           ['ref', 'seq'],
  [CHAT_MARK_QUEUED]:      ['ref', 'seq'],
  [MSG_USER]:              ['id', 'text'],
  [MSG_EDIT]:              ['id', 'ref', 'newText'],
  [STREAM_TEXT]:           ['streamId', 'text', 'seq'],
  [STREAM_MUTABLE_OPEN]:   ['streamId', 'regionId', 'text', 'seq'],
  [STREAM_MUTABLE_UPDATE]: ['streamId', 'regionId', 'text', 'seq'],
  [STREAM_FLUSH]:          ['streamId', 'seq'],
  [INTERACTIVE_POST]:      ['ref', 'content', 'actions', 'seq'],
  [MODAL_OPEN]:            ['triggerId', 'modal', 'seq'],
  [MODAL_ACK]:             ['id', 'seq'],
  [ACTION_CLICK]:          ['id', 'actionId', 'value', 'triggerId', 'userId'],
  [MODAL_SUBMIT]:          ['id', 'callbackId', 'privateMetadata', 'values', 'userId'],
  [TRANSCRIPT_REPLAY]:     ['sessionId', 'items', 'seqStart', 'seqEnd', 'isCatchUp'],
  [NOTIFICATION]:          ['kind', 'projectId', 'title', 'body', 'seq'],
  [UI_QUERY]:              ['id', 'scope'],
  [UI_QUERY_RESULT]:       ['id', 'ok'],
  [UI_MUTATE]:             ['id', 'op', 'args'],
  [UI_MUTATE_RESULT]:      ['id', 'ok'],
  [UI_SUBSCRIBE]:          ['id', 'filter'],
  [UI_EVENT]:              ['id', 'event', 'seq'],
  [UI_UNSUBSCRIBE]:        ['id'],
  [ERROR]:                 ['code', 'message'],
};

// ── Parse / Encode ──

export function parseFrame(raw: string): TuiFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.type !== 'string') return null;

  const required = REQUIRED_FIELDS[p.type];
  if (!required) return null;

  for (const field of required) {
    if (p[field] === undefined || p[field] === null) return null;
  }

  return parsed as TuiFrame;
}

export function encodeFrame(f: TuiFrame): string {
  return JSON.stringify(f);
}

// ── Re-exports from platform/types (convenience, type-only) ──

export type {
  MessageRef, MessageContent, RichBlock, ActionElement,
  ModalDefinition, ModalField, ModalFieldValue,
} from '../types.js';
