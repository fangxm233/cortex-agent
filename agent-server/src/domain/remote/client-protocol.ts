// The control-socket frames shared with cortex-client. The client package owns the declaration
// file; it is imported type-only so the server never depends on the client at runtime.
export type {
  ClientAction,
  ClientCapability,
  ClientFrame,
  HelloFrame,
  ResultFrame,
  UpdateResultFrame,
  ServerFrame,
  CommandFrame,
  OpenStreamFrame,
  OpenFileStreamFrame,
  UpdateFrame,
} from '../../../../client/src/protocol.js';
