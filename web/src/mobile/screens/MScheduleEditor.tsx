import { useVocab } from '@/i18n';
import {
  EditorFields,
  EditorHeader,
  type MScheduleEditorProps,
} from './MScheduleEditorFields';

export type { MScheduleEditorProps } from './MScheduleEditorFields';

export function MScheduleEditor(props: MScheduleEditorProps) {
  const copy = useVocab();
  const fields = { ...props, copy };
  return (
    <div data-mobile-schedule-editor>
      <EditorHeader {...fields} />
      <EditorFields {...fields} />
    </div>
  );
}
