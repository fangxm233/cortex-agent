/**
 * The control-socket protocol between agent-server and cortex-client: one JSON frame per WebSocket
 * message. Both packages import these types; neither may import the other at runtime (the client
 * is published and bundled on its own), which is why this is a declaration file — the server can
 * pull it in with `import type` without it becoming part of the server's compiled sources.
 *
 * Runtime values that must agree across the wire (the auth header name) live in each package and
 * are pinned to the literal types here.
 */

/** Upgrade header carrying the client token on the control socket and its callback sockets. */
export type AuthHeader = 'x-cortex-token';

/**
 * Features a client announces in `hello`. A server checks them before relying on a newer
 * protocol feature, because devices self-update on their own schedule and an old client must get a
 * clear error rather than a timeout.
 */
export type ClientCapability = 'file-stream' | 'rg';

/** Commands a client executes and answers with a `result` frame. */
export type ClientAction = 'bash' | 'read' | 'file.stat' | 'write' | 'edit' | 'glob' | 'grep';

// --- Client → server ---

export interface HelloFrame {
  type: 'hello';
  device: string;
  platform: string;
  capabilities: ClientCapability[];
  /** null when the client could not probe; the server keeps its configured value. */
  gpuCount: number | null;
  /** sha256 over the running bundle; the server pushes an update when it differs. */
  bundleHash: string;
}

export interface HeartbeatFrame {
  type: 'heartbeat';
  device: string;
  timestamp: number;
}

export interface ResultFrame {
  type: 'result';
  commandId: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface UpdateResultFrame {
  type: 'update-result';
  updateId?: string;
  device: string;
  hash: string;
  ok: boolean;
  error?: string;
}

export type ClientFrame = HelloFrame | HeartbeatFrame | ResultFrame | UpdateResultFrame;

// --- Server → client ---

export interface CommandFrame {
  type: 'command';
  commandId: string;
  action: ClientAction;
  params: Record<string, unknown>;
}

/** Dial back a raw TCP stream to a loopback port on the device (port forward). */
export interface OpenStreamFrame {
  type: 'open-stream';
  streamId: string;
  host: string;
  port: number;
}

/** Dial back and push the bytes of a file on the device. */
export interface OpenFileStreamFrame {
  type: 'open-file-stream';
  streamId: string;
  path: string;
}

/** A new client bundle to install; files are base64 in BUNDLE_FILES order. */
export interface UpdateFrame {
  type: 'update';
  updateId?: string;
  version?: string;
  hash: string;
  files: Array<{ name: string; data: string }>;
}

export type ServerFrame = CommandFrame | OpenStreamFrame | OpenFileStreamFrame | UpdateFrame;
