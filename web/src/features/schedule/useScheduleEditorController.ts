// input:  config/schedule tRPC endpoints, project scope, and optional outcome callbacks
// output: headless shared profile/form/create/update/invalidation schedule editor state
// pos:    Cross-surface schedule editor data controller
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ScheduleInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import {
  applyEditableSchedulePatch,
  buildScheduleAddArgs,
  buildScheduleUpdateArgs,
  defaultScheduleForm,
  editableScheduleFields,
  formFromSchedule,
  profileOptions,
  validateScheduleForm,
  type ScheduleEditableFields,
  type ScheduleEditorMode,
  type ScheduleForm,
} from './schedule-modal-vm';

interface EditorState {
  mode: ScheduleEditorMode;
  form: ScheduleForm;
  schedule: ScheduleInfo | null;
}

export interface ScheduleEditorControllerOptions {
  onCreated?: () => void;
  onUpdated?: () => void;
  onError?: (mode: ScheduleEditorMode, error: Error) => void;
}

export interface ScheduleEditorController {
  form: ScheduleForm | null;
  mode: ScheduleEditorMode | null;
  profileOptions: string[];
  editableFields: ScheduleEditableFields;
  valid: boolean;
  pending: boolean;
  error: string | null;
  openCreate: (options?: { projectId?: string | null }) => void;
  openEdit: (schedule: ScheduleInfo) => void;
  close: () => void;
  onChange: (patch: Partial<ScheduleForm>) => void;
  submit: () => Promise<boolean>;
}

interface SaveActions {
  add: (form: ScheduleForm) => Promise<unknown>;
  update: (scheduleId: string, form: ScheduleForm) => Promise<unknown>;
  invalidate: () => Promise<unknown>;
  success: (mode: ScheduleEditorMode) => void;
  failure: (mode: ScheduleEditorMode, error: Error) => void;
  close: () => void;
}

function toError(caught: unknown): Error {
  return caught instanceof Error ? caught : new Error(String(caught));
}

async function writeEditorState(state: EditorState, actions: SaveActions): Promise<boolean> {
  if (state.mode === 'edit') {
    if (!state.schedule) return false;
    await actions.update(state.schedule.id, state.form);
  } else {
    await actions.add(state.form);
  }
  return true;
}

async function saveEditorState(state: EditorState, actions: SaveActions): Promise<boolean> {
  try {
    if (!await writeEditorState(state, actions)) return false;
    await actions.invalidate();
    actions.success(state.mode);
    actions.close();
    return true;
  } catch (caught) {
    actions.failure(state.mode, toError(caught));
    return false;
  }
}

function useEditorState() {
  const [state, setState] = useState<EditorState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const close = useCallback(() => { setState(null); setError(null); }, []);
  const openCreate = useCallback((options?: { projectId?: string | null }) => {
    setError(null);
    setState({ mode: 'create', form: defaultScheduleForm(options?.projectId ?? null), schedule: null });
  }, []);
  const openEdit = useCallback((schedule: ScheduleInfo) => {
    setError(null);
    setState({ mode: 'edit', form: formFromSchedule(schedule), schedule });
  }, []);
  const onChange = useCallback((patch: Partial<ScheduleForm>) => {
    setState((current) => current ? {
      ...current, form: applyEditableSchedulePatch(current.form, current.mode, patch),
    } : current);
  }, []);
  return { state, error, setError, close, openCreate, openEdit, onChange };
}

function useScheduleResources(form: ScheduleForm | null) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const config = useQuery(trpc.config.get.queryOptions({}));
  const add = useMutation(trpc.schedules.add.mutationOptions({}));
  const update = useMutation(trpc.schedules.update.mutationOptions({}));
  const names = config.data?.profiles?.profiles.map((profile) => profile.name);
  return {
    add, update, pending: add.isPending || update.isPending,
    profiles: profileOptions(names, form?.profile ?? ''),
    invalidate: () => queryClient.invalidateQueries(trpc.schedules.list.queryFilter()),
  };
}

function useScheduleSubmit(state: EditorState | null,
  resources: ReturnType<typeof useScheduleResources>,
  editor: ReturnType<typeof useEditorState>, options: ScheduleEditorControllerOptions) {
  return useCallback(async (): Promise<boolean> => {
    if (!state || resources.pending) return false;
    if (!validateScheduleForm(state.form, state.mode).ok) return false;
    editor.setError(null);
    return saveEditorState(state, {
      add: (form) => resources.add.mutateAsync(buildScheduleAddArgs(form)),
      update: (id, form) => resources.update.mutateAsync(buildScheduleUpdateArgs(id, form)),
      invalidate: resources.invalidate,
      success: (mode) => mode === 'edit' ? options.onUpdated?.() : options.onCreated?.(),
      failure: (mode, error) => {
        editor.setError(error.message);
        options.onError?.(mode, error);
      },
      close: editor.close,
    });
  }, [editor.close, editor.setError, options, resources, state]);
}

function editorForm(state: EditorState | null): ScheduleForm | null {
  return state?.form ?? null;
}

function editorMode(state: EditorState | null): ScheduleEditorMode | null {
  return state?.mode ?? null;
}

function effectiveMode(mode: ScheduleEditorMode | null): ScheduleEditorMode {
  return mode ?? 'create';
}

function effectiveType(form: ScheduleForm | null): ScheduleForm['type'] {
  return form?.type ?? 'daily';
}

function editorValid(form: ScheduleForm | null, mode: ScheduleEditorMode): boolean {
  return form ? validateScheduleForm(form, mode).ok : false;
}

function editorView(state: EditorState | null) {
  const form = editorForm(state);
  const mode = editorMode(state);
  const activeMode = effectiveMode(mode);
  return {
    form, mode,
    editableFields: editableScheduleFields(activeMode, effectiveType(form)),
    valid: editorValid(form, activeMode),
  };
}

export function useScheduleEditorController(
  options: ScheduleEditorControllerOptions = {},
): ScheduleEditorController {
  const editor = useEditorState();
  const view = editorView(editor.state);
  const resources = useScheduleResources(view.form);
  const submit = useScheduleSubmit(editor.state, resources, editor, options);
  return {
    ...view, profileOptions: resources.profiles,
    pending: resources.pending, error: editor.error,
    openCreate: editor.openCreate, openEdit: editor.openEdit,
    close: editor.close, onChange: editor.onChange, submit,
  };
}
