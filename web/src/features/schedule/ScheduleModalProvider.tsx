import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ScheduleInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import { ScheduleModal } from './ScheduleModal';
import {
  defaultScheduleForm,
  formFromSchedule,
  buildScheduleAddArgs,
  buildScheduleUpdateArgs,
  validateScheduleForm,
  profileOptions,
  type ScheduleForm,
} from './schedule-modal-vm';

// Global mount + open/close controller for the New-schedule overlay (design 7c). A single modal
// instance lives here; any surface (Overview Schedules "+ New") opens it via useScheduleModal().
// The provider owns the form state + the real `schedules.add` tRPC mutation and invalidates
// `schedules.list` on success. Mirrors the global ⌘K / execution-log-drawer mounts in AppShell.
// Edit mode (design 27b「Edit schedule ↗」): openEdit(schedule) prefills the form and submits
// through `schedules.update` instead — the type/target/fallback stay fixed (not patchable).

interface OpenOptions {
  projectId?: string | null;
}

interface ScheduleModalContextValue {
  open: (opts?: OpenOptions) => void;
  openEdit: (schedule: ScheduleInfo) => void;
  close: () => void;
}

const ScheduleModalContext = createContext<ScheduleModalContextValue | null>(null);

export function ScheduleModalProvider({ children }: { children: ReactNode }) {
  const L = useVocab();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState<ScheduleForm | null>(null);
  // Non-null while editing an existing schedule → submit routes to schedules.update.
  const [editingId, setEditingId] = useState<string | null>(null);

  // Real selectable profiles come from the redacted config.get snapshot (profiles.json → names).
  const configQuery = useQuery(trpc.config.get.queryOptions({}));
  const profileNames = configQuery.data?.profiles?.profiles.map((p) => p.name);

  const close = useCallback(() => {
    setForm(null);
    setEditingId(null);
  }, []);
  const open = useCallback((opts?: OpenOptions) => {
    setEditingId(null);
    setForm(defaultScheduleForm(opts?.projectId ?? null));
  }, []);
  const openEdit = useCallback((schedule: ScheduleInfo) => {
    setEditingId(schedule.id);
    setForm(formFromSchedule(schedule));
  }, []);

  const addSchedule = useMutation(
    trpc.schedules.add.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(trpc.schedules.list.queryFilter());
        toast({ title: L.scToastCreated, tone: 'done' });
        close();
      },
      onError: (err) => {
        toast({ title: L.scToastCreateFailed, description: err.message, tone: 'failed' });
      },
    }),
  );

  const updateSchedule = useMutation(
    trpc.schedules.update.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(trpc.schedules.list.queryFilter());
        toast({ title: L.scToastUpdated, tone: 'done' });
        close();
      },
      onError: (err) => {
        toast({ title: L.scToastUpdateFailed, description: err.message, tone: 'failed' });
      },
    }),
  );

  const onChange = useCallback((patch: Partial<ScheduleForm>) => {
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const onSubmit = useCallback(() => {
    setForm((prev) => {
      if (prev && validateScheduleForm(prev).ok) {
        if (editingId) updateSchedule.mutate(buildScheduleUpdateArgs(editingId, prev));
        else addSchedule.mutate(buildScheduleAddArgs(prev));
      }
      return prev;
    });
  }, [addSchedule, updateSchedule, editingId]);

  const value = useMemo(() => ({ open, openEdit, close }), [open, openEdit, close]);

  return (
    <ScheduleModalContext.Provider value={value}>
      {children}
      {form && (
        <ScheduleModal
          form={form}
          mode={editingId ? 'edit' : 'create'}
          onChange={onChange}
          onCancel={close}
          onCreate={onSubmit}
          valid={validateScheduleForm(form).ok}
          pending={addSchedule.isPending || updateSchedule.isPending}
          profileOptions={profileOptions(profileNames, form.profile)}
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
