import { useCallback, useEffect, useMemo } from 'react';
import type { ScheduleInfo } from '@cortex-agent/ui-contract';
import { defineModal } from '@/design/modal-registry';
import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import { ScheduleModal } from './ScheduleModal';
import {
  useScheduleEditorController,
  type ScheduleEditorControllerOptions,
  type ScheduleEditorRequest,
} from './useScheduleEditorController';

interface OpenOptions {
  projectId?: string | null;
}

interface ScheduleModalContextValue {
  open: (opts?: OpenOptions) => void;
  openEdit: (schedule: ScheduleInfo) => void;
  close: () => void;
}

// The editor's form state is only meaningful while the modal is up, so it lives in the surface
// below rather than in a provider: the registry carries the request that opened it, and the
// controller is seeded from that request on mount. `seq` makes a second open while one is already
// up remount the surface instead of leaving the first form on screen.
type ScheduleModalRequest = ScheduleEditorRequest & { seq: number };

const scheduleModal = defineModal<ScheduleModalRequest>('schedule-editor');

let nextSeq = 0;

export function useScheduleModal(): ScheduleModalContextValue {
  const { open, close } = scheduleModal.useModalActions();
  return useMemo(() => ({
    open: (opts?: OpenOptions) => open({ seq: ++nextSeq, mode: 'create', projectId: opts?.projectId ?? null }),
    openEdit: (schedule: ScheduleInfo) => open({ seq: ++nextSeq, mode: 'edit', schedule }),
    close,
  }), [open, close]);
}

function useEditorOutcomes(): ScheduleEditorControllerOptions {
  const L = useVocab();
  const { toast } = useToast();
  const onCreated = useCallback(() => {
    toast({ title: L.scToastCreated, tone: 'done' });
  }, [L.scToastCreated, toast]);
  const onUpdated = useCallback(() => {
    toast({ title: L.scToastUpdated, tone: 'done' });
  }, [L.scToastUpdated, toast]);
  const onError = useCallback((mode: 'create' | 'edit', error: Error) => {
    toast({ title: mode === 'edit' ? L.scToastUpdateFailed : L.scToastCreateFailed,
      description: error.message, tone: 'failed' });
  }, [L.scToastCreateFailed, L.scToastUpdateFailed, toast]);
  return { onCreated, onUpdated, onError };
}

function ScheduleEditorSurface({ request, onClose }: {
  request: ScheduleModalRequest;
  onClose: () => void;
}) {
  const editor = useScheduleEditorController(useEditorOutcomes(), request);
  // A completed save closes the editor from inside the controller; drop the registry key with it so
  // the surface unmounts exactly where the old provider stopped rendering its modal.
  const { form, close } = editor;
  useEffect(() => {
    if (!form) onClose();
  }, [form, onClose]);
  // Cancel goes through the controller too: it bumps the generation, which is what makes a save
  // that is still in flight land silently instead of toasting over the dismissed form.
  const cancel = () => {
    close();
    onClose();
  };
  if (!editor.form || !editor.mode) return null;
  return (
    <ScheduleModal
      form={editor.form}
      mode={editor.mode}
      editableFields={editor.editableFields}
      onChange={editor.onChange}
      onCancel={cancel}
      onCreate={() => { void editor.submit(); }}
      valid={editor.valid}
      pending={editor.pending}
      profileOptions={editor.profileOptions}
    />
  );
}

export function ScheduleModalHost(): JSX.Element | null {
  const { payload, close } = scheduleModal.useModal();
  if (!payload) return null;
  return <ScheduleEditorSurface key={payload.seq} request={payload} onClose={close} />;
}
