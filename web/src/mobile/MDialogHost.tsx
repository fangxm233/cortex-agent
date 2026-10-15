import type { CSSProperties } from 'react';
import { Modal } from '@/design/Modal';
import { CONTAIN_DIALOG_CLICK, CONTAIN_DIALOG_ESCAPE, dismissOnClose, useDialogForm } from '@/design/DialogHost';
import { restoreDialogFocus, useCurrentDialog, type DialogRequest } from '@/design/dialog-store';
import { useVocab } from '@/i18n';
import { MButton } from '@/mobile/ui/kit';

const CARD_STYLE: CSSProperties = {
  position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
  width: 'calc(100% - 48px)', maxWidth: 360, boxSizing: 'border-box',
  background: 'var(--material-overlay-bg)', borderRadius: 'var(--r-float)',
  backdropFilter: 'var(--glass-filter)', WebkitBackdropFilter: 'var(--glass-filter)',
  boxShadow: 'var(--material-overlay-shadow)', padding: '22px 18px 16px',
  overflowWrap: 'anywhere', animation: 'cxfade .18s ease',
};
const TITLE_STYLE: CSSProperties = {
  fontSize: 16, fontWeight: 700, lineHeight: 1.4, color: 'var(--proto-ink)', textAlign: 'center',
};
const DESCRIPTION_STYLE: CSSProperties = {
  fontSize: 13, lineHeight: 1.6, color: 'var(--proto-muted)', textAlign: 'center', marginTop: 8,
};
const INPUT_STYLE: CSSProperties = {
  display: 'block', width: '100%', height: 44, boxSizing: 'border-box', marginTop: 16,
  fontFamily: 'inherit', fontSize: 15, color: 'var(--proto-ink)',
  background: 'var(--material-control-bg)', border: '1px solid var(--proto-line-3)',
  borderRadius: 'var(--r-control)', boxShadow: 'var(--material-control-shadow)', padding: '0 12px',
};
const ACTIONS_STYLE: CSSProperties = { display: 'flex', gap: 10, marginTop: 18 };

function MDialogForm({ request }: { request: DialogRequest }) {
  const L = useVocab();
  const form = useDialogForm(request);
  return (
    <form onSubmit={form.submit} onClick={CONTAIN_DIALOG_CLICK}>
      <div aria-hidden="true" style={TITLE_STYLE}>{request.title}</div>
      {request.description && <div aria-hidden="true" style={DESCRIPTION_STYLE}>{request.description}</div>}
      {request.input && <input data-dialog-input="" autoFocus aria-label={request.input.label}
        placeholder={request.input.label} value={form.value} autoComplete="off" spellCheck={false}
        onChange={(event) => form.setValue(event.target.value)} style={INPUT_STYLE} />}
      <div style={ACTIONS_STYLE}>
        <MButton data-dialog-cancel="" style={{ flex: 1 }} onClick={form.cancel}>{request.cancelLabel ?? L.cancel}</MButton>
        <MButton data-dialog-confirm="" type="submit" style={{ flex: 1 }} disabled={!form.ready}
          variant={request.tone === 'danger' ? 'danger-outline' : 'accent'}>{request.confirmLabel}</MButton>
      </div>
    </form>
  );
}

/** Mobile renderer for confirmDialog / promptDialog: a centred card in the phone's own kit. */
export function MDialogHost() {
  const current = useCurrentDialog();
  if (!current) return null;
  return (
    <Modal open onOpenChange={dismissOnClose(current)} onEscapeKeyDown={CONTAIN_DIALOG_ESCAPE}
      onCloseAutoFocus={restoreDialogFocus} chrome="bare" layer="nested"
      title={current.title} description={current.description} contentStyle={CARD_STYLE}
      contentDataAttributes={{ 'data-app-dialog': current.input ? 'prompt' : 'confirm' }}>
      <MDialogForm key={current.id} request={current} />
    </Modal>
  );
}
