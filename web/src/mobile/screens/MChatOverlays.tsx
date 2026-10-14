import { useVocabOptional } from '@/i18n';
import { MBottomSheet, MC, MONO } from '@/mobile/ui/kit';
import { AttachMenu } from './MChatComposerPresentation';
import {
  BrowserSheet, ContextUsageSheet, SelectionSheets, SessionIdSheet, SessionStatsSheet,
} from './MChatSheets';
import { MChatSessionMenu } from './MChatSessionMenu';
import { MTeamSheet } from './MChatTeam';
import { MBoardSheet } from './MChatBoard';
import { MTodoSheet, MWaitSheet } from './MChatActivity';
import type { MChatSelectionView } from './m-chat-selection';
import type { MChatViewProps } from './MChatView.types';
import type { ChatOverlay } from './useChatOverlay';

interface OverlayProps {
  props: MChatViewProps;
  overlay: ChatOverlay;
}

function OriginalMessageSheet({ text, onClose }: { text: string; onClose: () => void }): JSX.Element {
  return (
    <MBottomSheet onClose={onClose}>
      <div style={{ font: `600 11px ${MONO}`, color: MC.muted, letterSpacing: '.05em', padding: '0 2px 8px' }}>{useVocabOptional().chatOriginalMessage}</div>
      <div style={{ background: 'var(--proto-card)', border: `1px solid ${MC.hairline}`, borderRadius: 'var(--r-card)', padding: '11px 13px', fontSize: 13, lineHeight: 1.6, color: MC.body, whiteSpace: 'pre-wrap', overflowWrap: 'break-word', maxHeight: '50vh', overflow: 'auto' }}>
        {text}
      </div>
    </MBottomSheet>
  );
}

/** The ⋯ menu and what it opens, the header's context-usage sheet, the activity strip's task, wait,
 *  team and board sheets, and the 已编辑 original. */
function SessionOverlays({ props, overlay }: OverlayProps): JSX.Element {
  const statsRows = props.sessionStatsRows?.length ? props.sessionStatsRows : null;
  return (
    <>
      <MChatSessionMenu metadataSession={props.metadataSession} open={overlay.is('more')}
        onClose={() => overlay.close('more')} onSessionId={() => overlay.open('sessionId')}
        onSessionStats={statsRows ? () => overlay.open('stats') : undefined} />
      {overlay.is('stats') && statsRows && <SessionStatsSheet rows={statsRows} onClose={() => overlay.close('stats')} />}
      {overlay.is('sessionId') && (
        <SessionIdSheet sessionId={props.sessionId} backendUuid={props.backendUuid} onClose={() => overlay.close('sessionId')} />
      )}
      {overlay.originalText != null && (
        <OriginalMessageSheet text={overlay.originalText} onClose={() => overlay.close('original')} />
      )}
      {overlay.is('context') && (props.contextUsageSupported || props.contextUsage != null) ? (
        <ContextUsageSheet usage={props.contextUsage ?? null} compactAction={props.contextCompactAction}
          onClose={() => overlay.close('context')} />
      ) : null}
      {overlay.is('todo') && <MTodoSheet props={props} onClose={() => overlay.close('todo')} />}
      {overlay.is('wait') && <MWaitSheet props={props} onClose={() => overlay.close('wait')} />}
      {overlay.is('team') && props.onOpenWorker && (
        <MTeamSheet workers={props.workers ?? []} onClose={() => overlay.close('team')}
          onOpen={(id) => { overlay.close('team'); props.onOpenWorker!(id); }} />
      )}
      {overlay.boardId && (
        <MBoardSheet boardId={overlay.boardId} onClose={() => overlay.close('board')}
          onOpenSession={(s) => props.onOpenBoardSession?.(s.sessionId)} />
      )}
    </>
  );
}

/** ＋ menu entry for browser control: shown where it is on or can still be chosen; tappable only
 *  where it can. */
function attachModes({ props, overlay }: OverlayProps) {
  const { browser } = props;
  return {
    browser: browser && (browser.onPick || browser.device)
      ? { device: browser.device, onOpen: browser.onPick ? () => overlay.open('browser') : undefined }
      : undefined,
  };
}

function ComposerOverlays({ props, overlay, files }: OverlayProps & {
  files: { camera: () => void; library: () => void; file: () => void };
}): JSX.Element {
  const { browser } = props;
  const pickBrowser = (device: string | null): void => { browser?.onPick?.(device); overlay.close('browser'); };
  return (
    <>
      {overlay.is('attach') && (
        <AttachMenu onClose={() => overlay.close('attach')} onCamera={files.camera} onLibrary={files.library}
          onFile={files.file} {...attachModes({ props, overlay })} onCommands={() => { if (props.onCommands) props.onCommands(); else if (!props.composerValue) props.onComposerChange('/'); }} />
      )}
      {overlay.is('browser') && (
        <BrowserSheet current={browser?.device ?? null} onClose={() => overlay.close('browser')} onPick={pickBrowser} />
      )}
    </>
  );
}

/** Every menu and sheet the chat opens. Their open state is the view's own (`useChatOverlay`); the
 *  engine and environment sheets follow the shared selection controller instead, whose open state
 *  also gates the model-catalog fetch. */
export function MChatOverlays({ props, overlay, selection, files }: OverlayProps & {
  selection: MChatSelectionView;
  files: { camera: () => void; library: () => void; file: () => void };
}): JSX.Element {
  return (
    <>
      <SessionOverlays props={props} overlay={overlay} />
      <ComposerOverlays props={props} overlay={overlay} files={files} />
      <SelectionSheets selection={props.selection} view={selection} onPick={props.onPickSelection} />
    </>
  );
}
