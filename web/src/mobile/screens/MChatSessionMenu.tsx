import type { ReactNode } from 'react';
import { SessionMetadata, type MetadataSession } from '@/features/session/metadata/SessionMetadata';
import { SessionMetadataMenuItems } from '@/features/session/metadata/SessionMetadataMenuItems';
import { MoreMenu } from './MChatSheets';

interface Props {
  /** Null for a draft; omitted in metadata-free previews. */
  metadataSession?: MetadataSession | null;
  open: boolean;
  onClose: () => void;
  onSessionId: () => void;
  /** Absent until the session has whole-session totals to show. */
  onSessionStats?: () => void;
}

function MobileMenu({ props, metadataItems }: { props: Props; metadataItems?: ReactNode }): JSX.Element | null {
  if (!props.open) return null;
  const { onClose, onSessionId, onSessionStats } = props;
  return <MoreMenu onClose={onClose} metadataItems={metadataItems}
    onSessionId={() => { onClose(); onSessionId(); }}
    onSessionStats={onSessionStats ? () => { onClose(); onSessionStats(); } : undefined} />;
}

/** Keep metadata state mounted when the popover closes to open its rename/error dialog. */
export function MChatSessionMenu(props: Props): JSX.Element {
  if (props.metadataSession === undefined) return <MobileMenu props={props} />;
  return <SessionMetadata session={props.metadataSession}>
    {(actions) => <MobileMenu props={props} metadataItems={
      <SessionMetadataMenuItems actions={actions} touch onClose={props.onClose} />
    } />}
  </SessionMetadata>;
}
