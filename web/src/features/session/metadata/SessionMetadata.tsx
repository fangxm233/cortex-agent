import { useId, type CSSProperties, type ReactNode } from 'react';
import { Button } from '@/design/Button';
import { Modal } from '@/design/Modal';
import { useLang } from '@/i18n';
import { metadataCopy } from './metadata-copy';
import { useSessionMetadata, validSessionTitle, type MetadataSession, type SessionMetadataActions } from './useSessionMetadata';

export type { MetadataSession, SessionMetadataActions } from './useSessionMetadata';
type Props = { session: MetadataSession | null; children: (actions: SessionMetadataActions) => ReactNode };

const TITLE_INPUT_STYLE: CSSProperties = {
  display: 'block', width: '100%', minWidth: 0, minHeight: 34, boxSizing: 'border-box',
  fontFamily: 'inherit', fontSize: 13, lineHeight: 1.5, color: 'var(--proto-ink)',
  background: 'var(--material-control-bg)', border: '1px solid var(--proto-line-3)',
  borderRadius: 'var(--r-control)', boxShadow: 'var(--material-control-shadow)',
  padding: '6px 10px', outlineOffset: -2,
};

function RenameDialog({ actions }: { actions: SessionMetadataActions }): JSX.Element {
  const copy = metadataCopy(useLang());
  const id = useId();
  const valid = validSessionTitle(actions.draft);
  return <Modal title={copy.rename} description={copy.invalidTitle} open={actions.renameOpen}
    onOpenChange={(open) => { if (!open) actions.closeRename(); }} showClose={false}>
    <form onSubmit={(event) => { event.preventDefault(); actions.saveRename(); }}>
      <label htmlFor={id} className="block mb-1g">{copy.title}</label>
      <input id={id} autoFocus value={actions.draft} disabled={actions.pending}
        aria-invalid={!valid} aria-describedby={!valid ? `${id}-validation` : undefined}
        onChange={(event) => actions.setDraft(event.target.value)}
        style={TITLE_INPUT_STYLE} />
      {!valid && <p id={`${id}-validation`} className="mt-1g text-state-fail">{copy.invalidTitle}</p>}
      {actions.error && <p role="alert" className="mt-1g text-state-fail">{actions.error}</p>}
      <div className="flex justify-end gap-1g mt-2g">
        <Button disabled={actions.pending} onClick={actions.closeRename}>{copy.cancel}</Button>
        <Button type="submit" variant="primary" disabled={actions.pending || !valid}>
          {actions.pending ? copy.saving : copy.save}
        </Button>
      </div>
    </form>
  </Modal>;
}

function MetadataState({ session, children }: Props): JSX.Element {
  const copy = metadataCopy(useLang());
  const actions = useSessionMetadata(session, copy.failed);
  return <>
    {children(actions)}
    {actions.renameOpen && <RenameDialog actions={actions} />}
    {actions.error && !actions.renameOpen && <Modal title={copy.failed} open
      onOpenChange={(open) => { if (!open) actions.clearError(); }} showClose={false}
      footer={<Button onClick={actions.clearError}>{copy.close}</Button>}>
      <p role="alert">{actions.error}</p>
    </Modal>}
  </>;
}

export function SessionMetadata(props: Props): JSX.Element {
  return <MetadataState key={props.session?.sessionId ?? '__draft__'} {...props} />;
}
