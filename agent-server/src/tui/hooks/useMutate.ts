import { useEffect, useRef, useCallback } from 'react';
import { randomUUID } from 'crypto';
import { isUiMutateResult } from '../../platform/tui/protocol.js';
import type { TuiFrame, UiMutate } from '../../platform/tui/protocol.js';

// ── Types ──

export interface MutateSuccess {
  ok: true;
  data?: unknown;
}

export interface MutateError {
  ok: false;
  error: { code: string; message: string };
}

export type MutateResult = MutateSuccess | MutateError;

interface PendingEntry {
  resolve: (result: MutateResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface UseMutateOpts {
  sendFrame: (frame: TuiFrame) => void;
  onFrame?: (frame: TuiFrame) => void;
}

export interface UseMutateResult {
  mutate: (op: string, args: Record<string, unknown>) => Promise<MutateResult>;
  handleFrame: (frame: TuiFrame) => void;
}

// ── Hook ──

export function useMutate({ sendFrame, onFrame }: UseMutateOpts): UseMutateResult {
  const pendingRef = useRef<Map<string, PendingEntry>>(new Map());
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  // Cleanup pending entries on unmount
  useEffect(() => {
    const pending = pendingRef.current;
    return () => {
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
      }
      pending.clear();
    };
  }, []);

  const handleFrame = useCallback((frame: TuiFrame): void => {
    if (isUiMutateResult(frame)) {
      const pending = pendingRef.current;
      const entry = pending.get(frame.id);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(frame.id);
        if (frame.ok) {
          entry.resolve({ ok: true as const, data: (frame as { ok: true; data?: unknown }).data });
        } else {
          entry.resolve({ ok: false as const, error: (frame as { ok: false; error: { code: string; message: string } }).error });
        }
        return; // Consumed — do not pass through
      }
    }
    // Pass through to user's handler
    onFrameRef.current?.(frame);
  }, []);

  const mutate = useCallback(
    (op: string, args: Record<string, unknown>): Promise<MutateResult> => {
      const id = randomUUID();
      return new Promise<MutateResult>((resolve) => {
        const timer = setTimeout(() => {
          const pending = pendingRef.current;
          if (pending.has(id)) {
            pending.delete(id);
            resolve({ ok: false, error: { code: 'timeout', message: 'no ui.mutateResult within 10s' } });
          }
        }, 10_000);
        pendingRef.current.set(id, { resolve, timer });
        sendFrame({ type: 'ui.mutate', id, op, args } as UiMutate);
      });
    },
    [sendFrame],
  );

  return { mutate, handleFrame };
}
