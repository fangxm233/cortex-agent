// input:  PI extension UI calls, host answers keyed by request id
// output: An ExtensionUIContext that surfaces dialogs as extension_ui_request records
// pos:    Host side of PI's extension UI protocol for in-process sessions
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { randomUUID } from 'node:crypto';
import type { ExtensionUIContext, ExtensionUIDialogOptions, Theme } from '@earendil-works/pi-coding-agent';

/** Raw record shape the event pipeline already understands (same as PI's RPC wire format). */
export type PiUiRecord = Record<string, unknown> & { type: 'extension_ui_request'; id: string; method: string };

interface PendingDialog {
  resolve: (response: Record<string, unknown>) => void;
  cleanup: () => void;
}

export interface PiUiContextHandle {
  ui: ExtensionUIContext;
  /** Answer a blocking dialog. False when no dialog with that id is waiting. */
  respond(id: string, payload: Record<string, unknown>): boolean;
  /** Resolve every waiting dialog as cancelled (session teardown). */
  cancelAll(): void;
}

function cancelled(response: Record<string, unknown>): boolean {
  return response['cancelled'] === true;
}

function stringValue(response: Record<string, unknown>): string | undefined {
  if (cancelled(response)) return undefined;
  const value = response['value'];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Mirror of PI's RPC-mode UI context: dialog methods block on a host answer correlated by id,
 * everything else is fire-and-forget or unsupported without a terminal. Cortex answers through
 * `respond`, which orchestration reaches as `sendExtensionUiResponse`.
 */
export function createPiUiContext(
  emit: (record: PiUiRecord) => void,
  theme: Theme,
): PiUiContextHandle {
  const pending = new Map<string, PendingDialog>();

  function dialog<T>(
    request: Record<string, unknown>,
    fallback: T,
    parse: (response: Record<string, unknown>) => T,
    opts?: ExtensionUIDialogOptions,
  ): Promise<T> {
    if (opts?.signal?.aborted) return Promise.resolve(fallback);
    const id = randomUUID();
    return new Promise<T>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => { cleanup(); resolve(fallback); };
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        opts?.signal?.removeEventListener('abort', onAbort);
        pending.delete(id);
      };
      opts?.signal?.addEventListener('abort', onAbort, { once: true });
      if (opts?.timeout) {
        timer = setTimeout(() => { cleanup(); resolve(fallback); }, opts.timeout);
        timer.unref?.();
      }
      pending.set(id, { resolve: (response) => { cleanup(); resolve(parse(response)); }, cleanup });
      emit({ type: 'extension_ui_request', id, ...request } as PiUiRecord);
    });
  }

  function fire(method: string, fields: Record<string, unknown>): void {
    emit({ type: 'extension_ui_request', id: randomUUID(), method, ...fields });
  }

  const ui: ExtensionUIContext = {
    select: (title, options, opts) => dialog(
      { method: 'select', title, options, timeout: opts?.timeout }, undefined, stringValue, opts,
    ),
    confirm: (title, message, opts) => dialog(
      { method: 'confirm', title, message, timeout: opts?.timeout }, false,
      (response) => !cancelled(response) && response['confirmed'] === true, opts,
    ),
    input: (title, placeholder, opts) => dialog(
      { method: 'input', title, placeholder, timeout: opts?.timeout }, undefined, stringValue, opts,
    ),
    editor: (title, prefill) => dialog({ method: 'editor', title, prefill }, undefined, stringValue),
    notify: (message, type) => fire('notify', { message, notifyType: type }),
    setStatus: (key, text) => fire('setStatus', { statusKey: key, statusText: text }),
    setWidget: (key: string, content: unknown, options?: { placement?: unknown }) => {
      if (content === undefined || Array.isArray(content)) {
        fire('setWidget', { widgetKey: key, widgetLines: content, widgetPlacement: options?.placement });
      }
    },
    setTitle: (title) => fire('setTitle', { title }),
    setEditorText: (text) => fire('set_editor_text', { text }),
    pasteToEditor: (text) => fire('set_editor_text', { text }),
    // No terminal behind this context: the remaining members are inert, exactly as in PI's RPC mode.
    onTerminalInput: () => () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setFooter: () => {},
    setHeader: () => {},
    custom: async () => undefined as never,
    getEditorText: () => '',
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    get theme() { return theme; },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: 'Theme switching not supported in Cortex sessions' }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };

  return {
    ui,
    respond(id, payload) {
      const entry = pending.get(id);
      if (!entry) return false;
      entry.resolve(payload);
      return true;
    },
    cancelAll() {
      for (const entry of [...pending.values()]) entry.resolve({ cancelled: true });
    },
  };
}
