import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import type { ScheduleEditorControllerOptions } from './useScheduleEditorController';

/** The toast every schedule editor host raises when a save lands or fails — shared by the desktop
 *  modal and the mobile sheet so both report outcomes with the same words and tones. */
export function useScheduleEditorToasts(): ScheduleEditorControllerOptions {
  const L = useVocab();
  const { toast } = useToast();
  return {
    onCreated: () => toast({ title: L.scToastCreated, tone: 'done' }),
    onUpdated: () => toast({ title: L.scToastUpdated, tone: 'done' }),
    onError: (mode, error) => toast({
      title: mode === 'edit' ? L.scToastUpdateFailed : L.scToastCreateFailed,
      description: error.message, tone: 'failed',
    }),
  };
}
