// input:  DTO-carrying schedule rows, shared editor controller, and back-aware bottom sheet
// output: one mobile sheet state machine spanning schedule list, runs, and editor levels
// pos:    Mobile Scheduled drill-in and editor sheet
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useCallback, useState } from 'react';
import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import { MBottomSheet } from '@/mobile/ui/kit';
import { scheduleRowAction, type ScheduleRow } from '@/features/workbench/schedule-rail';
import {
  useScheduleEditorController,
  type ScheduleEditorController,
} from '@/features/schedule/useScheduleEditorController';
import { MScheduleEditor } from './MScheduleEditor';
import {
  ListLevel,
  RunsLevel,
  type MScheduleSheetCopy,
} from './MScheduleSheetLevels';

export type { MScheduleSheetCopy } from './MScheduleSheetLevels';

type BaseSheetLevel = { kind: 'list' } | { kind: 'runs'; scheduleId: string };
type SheetLevel = BaseSheetLevel | { kind: 'editor'; returnTo: BaseSheetLevel };

interface MScheduleSheetViewProps {
  rows: ScheduleRow[];
  copy: MScheduleSheetCopy;
  editor: ScheduleEditorController;
  onOpenSession: (sessionId: string) => void;
  onClose: () => void;
  now?: number;
}

interface MScheduleSheetProps {
  rows: ScheduleRow[];
  copy: MScheduleSheetCopy;
  onOpenSession: (sessionId: string) => void;
  onClose: () => void;
}

function useSheetLevel(editor: ScheduleEditorController) {
  const [level, setLevel] = useState<SheetLevel>({ kind: 'list' });
  const back = useCallback(() => setLevel((current) => {
    if (current.kind === 'editor') {
      editor.close();
      return current.returnTo;
    }
    return { kind: 'list' };
  }), [editor.close]);
  const openEditor = useCallback((schedule: NonNullable<ScheduleRow['schedule']>,
    returnTo: BaseSheetLevel) => {
    editor.openEdit(schedule);
    setLevel({ kind: 'editor', returnTo });
  }, [editor.openEdit]);
  return { level, setLevel, back, openEditor };
}

function useRowAction(onOpenSession: (sessionId: string) => void,
  setLevel: React.Dispatch<React.SetStateAction<SheetLevel>>,
  openEditor: ReturnType<typeof useSheetLevel>['openEditor']) {
  return useCallback((row: ScheduleRow) => {
    const action = scheduleRowAction(row);
    if (action.type === 'modal') {
      setLevel({ kind: 'runs', scheduleId: row.scheduleId });
      return;
    }
    if (action.type === 'open') return onOpenSession(action.sessionId);
    openEditor(action.schedule, { kind: 'list' });
  }, [onOpenSession, openEditor, setLevel]);
}

function useEditorSubmit(editor: ScheduleEditorController,
  setLevel: React.Dispatch<React.SetStateAction<SheetLevel>>) {
  return useCallback(() => {
    void editor.submit().then((saved) => {
      if (!saved) return;
      setLevel((current) => current.kind === 'editor' ? current.returnTo : { kind: 'list' });
    });
  }, [editor.submit, setLevel]);
}

function currentRunsRow(rows: ScheduleRow[], level: SheetLevel): ScheduleRow | null {
  if (level.kind !== 'runs') return null;
  return rows.find((row) => row.scheduleId === level.scheduleId) ?? null;
}

function RunsSheetLevel({ row, copy, now, back, onOpenSession, openEditor }: {
  row: ScheduleRow; copy: MScheduleSheetCopy; now: number; back: () => void;
  onOpenSession: (sessionId: string) => void;
  openEditor: ReturnType<typeof useSheetLevel>['openEditor'];
}) {
  const onEdit = row.schedule
    ? () => openEditor(row.schedule!, { kind: 'runs', scheduleId: row.scheduleId })
    : undefined;
  return <RunsLevel row={row} copy={copy} now={now} onBack={back}
    onOpenRun={onOpenSession} onEdit={onEdit} />;
}

function editorLevelContent(level: SheetLevel, editor: ScheduleEditorController,
  submit: () => void, back: () => void) {
  if (level.kind !== 'editor') return null;
  if (!editor.form || !editor.mode) return null;
  return <MScheduleEditor form={editor.form} mode={editor.mode}
    editableFields={editor.editableFields} profileOptions={editor.profileOptions}
    valid={editor.valid} pending={editor.pending} error={editor.error}
    onChange={editor.onChange} onSubmit={submit} onBack={back} />;
}

function SheetLevelContent({ rows, copy, editor, level, runsRow, now, back,
  onOpenSession, onRow, openEditor, submit }: MScheduleSheetViewProps & {
  level: SheetLevel; runsRow: ScheduleRow | null; now: number; back: () => void;
  onRow: (row: ScheduleRow) => void; openEditor: ReturnType<typeof useSheetLevel>['openEditor'];
  submit: () => void;
}) {
  const editorContent = editorLevelContent(level, editor, submit, back);
  if (editorContent) return editorContent;
  if (runsRow) return <RunsSheetLevel row={runsRow} copy={copy} now={now} back={back}
    onOpenSession={onOpenSession} openEditor={openEditor} />;
  return <ListLevel rows={rows} copy={copy} now={now} onRow={onRow} />;
}

export function MScheduleSheetView(props: MScheduleSheetViewProps) {
  const { rows, editor, onOpenSession, onClose } = props;
  const navigation = useSheetLevel(editor);
  const runsRow = currentRunsRow(rows, navigation.level);
  const onRow = useRowAction(onOpenSession, navigation.setLevel, navigation.openEditor);
  const submit = useEditorSubmit(editor, navigation.setLevel);
  const closeSheet = useCallback(() => { editor.close(); onClose(); }, [editor.close, onClose]);
  const onBack = navigation.level.kind === 'list' ? undefined : navigation.back;
  return (
    <MBottomSheet onClose={closeSheet} onBack={onBack}>
      <SheetLevelContent {...props} level={navigation.level} runsRow={runsRow}
        now={props.now ?? Date.now()} back={navigation.back} onRow={onRow}
        openEditor={navigation.openEditor} submit={submit} />
    </MBottomSheet>
  );
}

export function MScheduleSheet(props: MScheduleSheetProps) {
  const copy = useVocab();
  const { toast } = useToast();
  const editor = useScheduleEditorController({
    onCreated: () => toast({ title: copy.scToastCreated, tone: 'done' }),
    onUpdated: () => toast({ title: copy.scToastUpdated, tone: 'done' }),
    onError: (mode, error) => toast({
      title: mode === 'edit' ? copy.scToastUpdateFailed : copy.scToastCreateFailed,
      description: error.message, tone: 'failed',
    }),
  });
  return <MScheduleSheetView {...props} editor={editor} />;
}
