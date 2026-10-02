import type { ReactNode } from 'react';
import { SessionMetadata } from '@/features/session/metadata/SessionMetadata';
import { SessionMetadataMenuItems } from '@/features/session/metadata/SessionMetadataMenuItems';
import { MoreMenu } from './MChatSheets';
import type { MChatViewProps } from './MChatView.types';

type Props = Pick<MChatViewProps, 'metadataSession' | 'copy' | 'moreOpen' | 'onMoreClose'
  | 'onSessionIdOpen' | 'sessionStatsRows' | 'onSessionStatsOpen'>;

function MobileMenu({ props, metadataItems }: { props: Props; metadataItems?: ReactNode }): JSX.Element | null {
  if (!props.moreOpen) return null;
  return <MoreMenu copy={props.copy} onClose={props.onMoreClose} metadataItems={metadataItems}
    onSessionId={() => { props.onMoreClose(); props.onSessionIdOpen(); }}
    onSessionStats={props.sessionStatsRows?.length
      ? () => { props.onMoreClose(); props.onSessionStatsOpen(); } : undefined} />;
}

/** Keep metadata state mounted when the popover closes to open its rename/error dialog. */
export function MChatSessionMenu(props: Props): JSX.Element {
  if (props.metadataSession === undefined) return <MobileMenu props={props} />;
  return <SessionMetadata session={props.metadataSession}>
    {(actions) => <MobileMenu props={props} metadataItems={
      <SessionMetadataMenuItems actions={actions} touch onClose={props.onMoreClose} />
    } />}
  </SessionMetadata>;
}
