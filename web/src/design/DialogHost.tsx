import { useState, type CSSProperties, type FormEvent, type MouseEvent } from 'react';
import { useVocabOptional } from '@/i18n';
import { Button } from './Button';
import { Modal } from './Modal';
import { restoreDialogFocus, settleDialog, useDialogPresentation, type DialogRequest } from './dialog-store';

const INPUT_STYLE: CSSProperties = {
  display: 'block', width: '100%', minWidth: 0, minHeight: 34, boxSizing: 'border-box',
  fontFamily: 'inherit', fontSize: 13, lineHeight: 1.5, color: 'var(--proto-ink)',
  background: 'var(--material-control-bg)', border: '1px solid var(--proto-line-3)',
  borderRadius: 'var(--r-control)', boxShadow: 'var(--material-control-shadow)',
  padding: '6px 10px', outlineOffset: -2,
};

export function useDialogForm(request: DialogRequest) {
  const [value, setValue] = useState(request.input?.initialValue ?? '');
  const ready = !request.input || value.trim().length > 0;
  return {
    value,
    setValue,
    ready,
    submit: (event?: FormEvent) => {
      event?.preventDefault();
      if (ready) settleDialog(request.id, request.input ? value : '');
    },
    cancel: () => settleDialog(request.id, null),
  };
}

/** Window-level click / Escape listeners (menus, popovers) close their surface on any click. Answering
 *  a dialog opened from one must not close it, as the browser's own confirm never did. Escape is
 *  stopped where Radix catches it (document capture), before the dialog unmounts under the event. */
export const CONTAIN_DIALOG_CLICK = (event: MouseEvent) => event.stopPropagation();
export const CONTAIN_DIALOG_ESCAPE = (event: KeyboardEvent) => event.stopPropagation();

/** Closing the dialog any other way (Escape, outside click) cancels the open request. */
export function dismissOnClose(current: DialogRequest | undefined): (open: boolean) => void {
  return (open) => { if (!open && current) settleDialog(current.id, null); };
}

function DialogForm({ request }: { request: DialogRequest }): JSX.Element {
  const L = useVocabOptional();
  const form = useDialogForm(request);
  return (
    <form onSubmit={form.submit} onClick={CONTAIN_DIALOG_CLICK} className="flex flex-col gap-2g">
      {request.input && <input data-dialog-input="" autoFocus aria-label={request.input.label}
        placeholder={request.input.label} value={form.value} autoComplete="off" spellCheck={false}
        onChange={(event) => form.setValue(event.target.value)} style={INPUT_STYLE} />}
      <div className="flex flex-wrap items-center justify-end gap-1g">
        <Button data-dialog-cancel="" onClick={form.cancel}>{request.cancelLabel ?? L.cancel}</Button>
        <Button data-dialog-confirm="" type="submit" disabled={!form.ready}
          variant={request.tone === 'danger' ? 'danger' : 'primary'}>{request.confirmLabel}</Button>
      </div>
    </form>
  );
}

/** Desktop renderer for confirmDialog / promptDialog. Mount once at the app root. */
export function DialogHost(): JSX.Element | null {
  const { current, shown } = useDialogPresentation();
  if (!shown) return null;
  return (
    <Modal open={!!current} onOpenChange={dismissOnClose(current)} onEscapeKeyDown={CONTAIN_DIALOG_ESCAPE}
      onCloseAutoFocus={restoreDialogFocus} title={shown.title}
      description={shown.description} showClose={false} layer="nested" size="custom"
      contentClassName="max-w-[420px] [overflow-wrap:anywhere]"
      contentDataAttributes={{ 'data-app-dialog': shown.input ? 'prompt' : 'confirm' }}>
      <DialogForm key={shown.id} request={shown} />
    </Modal>
  );
}
