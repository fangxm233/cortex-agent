// input:  declared trajectory root, journal and lifecycle write requests
// output: root-confined benchmark sinks and a delivery-free thread adapter
// pos:    Output-only persistence boundary for standalone trials
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import fs from 'node:fs';
import path from 'node:path';
import type { PlatformAdapter } from '../../platform/adapter.js';
import type { OutputStream } from '../../platform/output-stream.js';
import type { PlatformCapabilities } from '../../platform/types.js';
import { openJournal, type Journal } from './journal.js';
import {
  writeStartedMarker, writeTerminalManifest,
} from './manifest.js';

const OUTPUT_CAPABILITIES: PlatformCapabilities = {
  threads: false,
  messageEdit: false,
  modals: false,
  reactions: false,
  fileUpload: false,
  richFormatting: false,
  maxMessageLength: Infinity,
  maxThreadDepth: 0,
};

const OUTPUT_STREAM: OutputStream = {
  emitText: () => {},
  openMutable: () => ({ update: () => {} }),
  postInteractive: async () => null,
  flush: async () => {},
  getRefs: () => [],
  getParentRef: () => null,
};

function deliveryDisabled(): never {
  throw new Error('Benchmark output adapter has no platform delivery capability');
}

function outputThreadAdapter(): PlatformAdapter {
  return {
    name: 'benchmark-output-only', capabilities: OUTPUT_CAPABILITIES,
    start: async () => {}, stop: async () => {},
    onMessage: () => {}, onMessageEdit: () => {}, onAction: () => {}, onModalSubmit: () => {},
    postMessage: async () => deliveryDisabled(),
    updateMessage: async () => deliveryDisabled(),
    deleteMessage: async () => deliveryDisabled(),
    postInteractive: async () => deliveryDisabled(),
    openModal: async () => deliveryDisabled(),
    markQueued: async () => deliveryDisabled(),
    unmarkQueued: async () => deliveryDisabled(),
    uploadFile: async () => deliveryDisabled(),
    downloadFile: async () => deliveryDisabled(),
    getPermalink: async () => null,
    openOutputStream: () => OUTPUT_STREAM,
    bindProjectConduit: async () => deliveryDisabled(),
    unbindProjectConduit: async () => deliveryDisabled(),
    getProjectConduits: async () => ({}), resolveInboundProject: async () => null,
    ownsConduit: () => false,
  };
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative));
}

function confined(root: string, target: string): string {
  const resolved = path.resolve(target);
  if (!isWithin(root, resolved)) {
    throw new Error(`Benchmark output path escapes trajectory root: ${target}`);
  }
  let existing = resolved;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const physical = path.resolve(fs.realpathSync(existing), path.relative(existing, resolved));
  if (!isWithin(fs.realpathSync(root), physical)) {
    throw new Error(`Benchmark output path escapes physical trajectory root: ${target}`);
  }
  return resolved;
}

export interface BenchmarkOutputAdapter {
  readonly kind: 'benchmark-output-only';
  readonly root: string;
  readonly threadAdapter: PlatformAdapter;
  openJournal(options: Parameters<typeof openJournal>[0]): Journal;
  writeStarted(options: Parameters<typeof writeStartedMarker>[0]): string;
  writeTerminal(
    options: Parameters<typeof writeTerminalManifest>[0],
    validation?: Parameters<typeof writeTerminalManifest>[1],
  ): string;
}

function assertTrajectoryRoot(root: string, value: string): void {
  let physical: string;
  try { physical = fs.realpathSync(value); }
  catch { throw new Error(`Benchmark lifecycle root is unavailable: ${value}`); }
  if (physical !== root) {
    throw new Error(`Benchmark lifecycle root differs from output root: ${value}`);
  }
}

export function createBenchmarkOutputAdapter(trajectoryRoot: string): BenchmarkOutputAdapter {
  fs.mkdirSync(trajectoryRoot, { recursive: true });
  const root = fs.realpathSync(trajectoryRoot);
  return {
    kind: 'benchmark-output-only',
    root,
    threadAdapter: outputThreadAdapter(),
    openJournal(options) {
      return openJournal({ ...options, path: confined(root, options.path) });
    },
    writeStarted(options) {
      assertTrajectoryRoot(root, options.trajectoryRoot);
      return writeStartedMarker(options);
    },
    writeTerminal(options, validation) {
      assertTrajectoryRoot(root, options.trajectoryRoot);
      confined(root, options.journalPath);
      return writeTerminalManifest(options, validation);
    },
  };
}
