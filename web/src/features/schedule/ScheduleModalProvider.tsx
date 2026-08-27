// input:  global open/edit requests, shared editor controller, toast copy, and children
// output: desktop schedule context plus one controller-backed modal mount
// pos:    Global desktop schedule editor provider
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import type { ScheduleInfo } from '@cortex-agent/ui-contract';
import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import { ScheduleModal } from './ScheduleModal';
import {
  useScheduleEditorController,
  type ScheduleEditorControllerOptions,
} from './useScheduleEditorController';

interface OpenOptions {
  projectId?: string | null;
}

interface ScheduleModalContextValue {
  open: (opts?: OpenOptions) => void;
  openEdit: (schedule: ScheduleInfo) => void;
  close: () => void;
}

const ScheduleModalContext = createContext<ScheduleModalContextValue | null>(null);

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

export function ScheduleModalProvider({ children }: { children: ReactNode }) {
  const editor = useScheduleEditorController(useEditorOutcomes());
  const value = useMemo(() => ({
    open: editor.openCreate,
    openEdit: editor.openEdit,
    close: editor.close,
  }), [editor.close, editor.openCreate, editor.openEdit]);

  return (
    <ScheduleModalContext.Provider value={value}>
      {children}
      {editor.form && editor.mode && (
        <ScheduleModal
          form={editor.form}
          mode={editor.mode}
          editableFields={editor.editableFields}
          onChange={editor.onChange}
          onCancel={editor.close}
          onCreate={() => { void editor.submit(); }}
          valid={editor.valid}
          pending={editor.pending}
          profileOptions={editor.profileOptions}
        />
      )}
    </ScheduleModalContext.Provider>
  );
}

export function useScheduleModal(): ScheduleModalContextValue {
  const ctx = useContext(ScheduleModalContext);
  if (!ctx) {
    throw new Error('useScheduleModal must be used within a ScheduleModalProvider');
  }
  return ctx;
}
