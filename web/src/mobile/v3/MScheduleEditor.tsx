// input:  shared headless schedule editor state, editable gates, and navigation callbacks
// output: mobile schedule form composition without owning a second bottom sheet
// pos:    Editor level inside the Scheduled sheet state machine
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

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
