// input:  adapter + types + output-stream + adapters/* + composite-adapter
// output: Re-export full family of PlatformAdapter public APIs
// pos:    Public API export of the Platform abstraction
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

export type { PlatformAdapter } from './adapter.js';
export type {
  MessageRef,
  MessageContent,
  MessageContext,
  MessageEditContext,
  ActionContext,
  ModalSubmitContext,
  ModalDefinition,
  ModalField,
  ModalSelectField,
  ModalMultiSelectField,
  ModalTextInputField,
  ModalSectionField,
  SelectOption,
  ModalFieldValue,
  PlatformCapabilities,
  PlatformFileRef,
  DownloadedFile,
  IncomingMessage,
  IncomingAttachment,
  PostMessageOpts,
  FileUploadOpts,
  RichBlock,
  ActionElement,
  ButtonElement,
  Destination,
} from './types.js';
export type { OutputStream, MutableRegion, OpenOutputStreamOpts } from './output-stream.js';
export { postOnce } from './output-stream-helpers.js';
export { ToolTrace, createToolTrace, isToolTraceEnabled } from './tool-trace.js';
export {
  buildQuestionGroupBlocks,
  buildQuestionModalDefinition,
  buildPlanApprovalContent,
  buildPlanFeedbackModal,
  normalizeAskLevel,
  askLevelIcon,
} from './interactive-builder.js';
export type { QuestionOption, QuestionRecord, QuestionGroup } from './interactive-builder.js';
export { createAdapter, createAdapterFromEnv } from './adapters/index.js';
export type { PlatformType, AdapterConfig } from './adapters/index.js';
export { SlackAdapter } from './adapters/slack.js';
export type { SlackAdapterConfig } from './adapters/slack.js';
export { FeishuAdapter } from './adapters/feishu.js';
export type { FeishuAdapterConfig } from './adapters/feishu.js';
export { CompositeAdapter, extractTuiAdapter } from './adapters/composite-adapter.js';
