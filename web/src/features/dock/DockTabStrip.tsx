import { forwardRef, useCallback, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { AnimatePresence, MotionConfig, Reorder, motion, useIsPresent, useReducedMotion } from 'motion/react';
import { useMotionMode, type MotionMode } from '@/theme';
import { PlusGlyph } from '@/design';
import { browserTabChip, browserTabForwardSource, currentUrl, type BrowserTabChip } from '@/features/browser/browser-target';
import { useVocabOptional, type Vocab } from '@/i18n';
import { BoardTabTitle } from '@/features/board/BoardDockBody';
import { BoardIcon } from '@/features/board/BoardIcon';
import { AgentBrowserTabTitle } from '@/features/agent-browser/AgentBrowserTabTitle';
import {
  dockTabLabel, isAgentBrowserTab, isBoardTab, isFileTab, isWebTab, type DockState, type DockTab, type WebDockTab,
} from './dock-tabs';
import { DockTabMenu, PinGlyph, type TabMenuTarget } from './DockTabMenu';
import './dock-chrome.css';

// Keep the strip at the chat header's 50px height. Only chrome reorders; the pane's
// insertion-ordered bodies remain mounted. The scroller clips vertical drag overflow.
//
// A tab is plain muted text with a small glyph for its kind (the board's flag, a page for a file, a
// globe for the web); the selected tab alone is raised — control material, a hairline and a soft
// shadow. A web tab's port, or the device:port a forward came from, follows its label as quiet text.
// A pinned tab's ✕ is a pin instead (pressing it unpins); right-click opens pin / unpin / close.

interface StripProps {
  state: DockState | null;
  pinnedIds: ReadonlySet<string>;
  onAdd: () => void;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (orderedIds: string[]) => void;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
  /** Right-aligned controls that belong to the dock, not to any one tab. */
  actions?: ReactNode;
}

export function DockTabStrip(props: StripProps): JSX.Element {
  const motionMode = useMotionMode();
  const systemReduced = useReducedMotion();
  const reduceMotion = motionMode === 'reduced' || (motionMode === 'system' && systemReduced === true);
  const [menu, setMenu] = useState<TabMenuTarget | null>(null);
  const dismiss = useCallback(() => setMenu(null), []);
  const menuOpen = menu !== null && (props.state?.tabs.some((tab) => tab.id === menu.id) ?? false);
  return (
    <MotionConfig reducedMotion={motionReduction(motionMode)}>
      <div className="dock-strip">
        <TabScroller {...props} reduceMotion={reduceMotion} onMenu={setMenu} />
        {props.actions && <div className="dock-tab-actions">{props.actions}</div>}
      </div>
      {menuOpen && <DockTabMenu target={menu} pinned={props.pinnedIds.has(menu.id)} onPin={props.onPin}
        onUnpin={props.onUnpin} onClose={props.onClose} onDismiss={dismiss} />}
    </MotionConfig>
  );
}

type ScrollerProps = StripProps & { reduceMotion: boolean; onMenu: (target: TabMenuTarget) => void };

function TabScroller({ state, pinnedIds, onAdd, onReorder, ...item }: ScrollerProps): JSX.Element {
  const tabs = state?.tabs ?? [];
  const L = useVocabOptional();
  return (
    <Reorder.Group as="div" axis="x" values={tabs.map((tab) => tab.id)} onReorder={onReorder} layoutScroll className="dock-tab-scroll">
      <AnimatePresence initial={false} mode="popLayout">
        {tabs.map((tab) => <DockTabItem key={tab.id} tab={tab} active={tab.id === state?.activeId}
          pinned={pinnedIds.has(tab.id)} draggable={tabs.length > 1} reduceMotion={item.reduceMotion}
          onSelect={item.onSelect} onClose={item.onClose} onUnpin={item.onUnpin} onMenu={item.onMenu} />)}
      </AnimatePresence>
      <motion.button layout type="button" className="dock-control" data-add-tab="" title={L.brNewTab} aria-label={L.brNewTab} onClick={onAdd}>
        <PlusGlyph size={14} />
      </motion.button>
    </Reorder.Group>
  );
}

interface DockTabItemProps {
  tab: DockTab;
  active: boolean;
  pinned: boolean;
  draggable: boolean;
  reduceMotion: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onUnpin: (id: string) => void;
  onMenu: (target: TabMenuTarget) => void;
}

const DockTabItem = forwardRef<HTMLDivElement, DockTabItemProps>(function DockTabItem(props, ref): JSX.Element {
  const { tab, active, pinned, draggable, reduceMotion, onMenu } = props;
  const isPresent = useIsPresent();
  const openMenu = (event: MouseEvent) => {
    event.preventDefault();
    onMenu({ id: tab.id, x: event.clientX, y: event.clientY });
  };
  return (
    <Reorder.Item ref={ref} as="div" value={tab.id} dragListener={draggable && isPresent} dragElastic={0.08}
      initial={reduceMotion ? false : { opacity: 0, scale: 0.94 }}
      animate={reduceMotion ? undefined : { opacity: 1, scale: 1 }}
      exit={reduceMotion ? undefined : { opacity: 0, scale: 0.94, transition: { duration: 0.12, ease: 'easeIn' } }}
      transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 40, opacity: { duration: 0.12 }, scale: { duration: 0.14 } }}
      whileDrag={reduceMotion ? undefined : { scale: 1.03 }}
      className="dock-tab-item" data-selected={active} data-pinned={pinned ? 'true' : undefined}
      onContextMenu={openMenu} style={{ pointerEvents: isPresent ? 'auto' : 'none' }}>
      <TabButtons {...props} isPresent={isPresent} />
    </Reorder.Item>
  );
});

function TabButtons({ tab, active, onSelect, isPresent, ...trailing }: DockTabItemProps & { isPresent: boolean }): JSX.Element {
  const L = useVocabOptional();
  const plain = isFileTab(tab) || isWebTab(tab) ? tab : null;
  const label = plain ? dockTabLabel(plain, L.brNewTab) : null;
  const web = isWebTab(tab) ? tab : null;
  const source = web ? browserTabForwardSource(web) : null;
  const where = web ? browserTabChip(web) : null;
  const title = plain ? tabTooltip(plain, label!, source, L) : isAgentBrowserTab(tab) ? L.abTitle : undefined;
  return (
    <>
      <button type="button" className="dock-tab-select" aria-pressed={active} data-dock-tab={tab.id}
        data-tab-kind={tab.kind} data-active={active ? 'true' : 'false'} onClick={() => onSelect(tab.id)} title={title}>
        <TabIcon tab={tab} copy={L} />
        <span style={TAB_LABEL_STYLE}>
          {isBoardTab(tab) ? <BoardTabTitle boardId={tab.boardId} />
            : isAgentBrowserTab(tab) ? <AgentBrowserTabTitle sessionId={tab.sessionId} /> : label}
        </span>
        {web && where && <TabWhere tab={web} chip={where} source={source} copy={L} />}
      </button>
      <TabTrailing id={tab.id} pinned={trailing.pinned} disabled={!isPresent} onClose={trailing.onClose} onUnpin={trailing.onUnpin} />
    </>
  );
}

/** The tab's trailing button: ✕ closes it, or for a pinned tab the pin, which unpins it. */
function TabTrailing({ id, pinned, disabled, onClose, onUnpin }: {
  id: string;
  pinned: boolean;
  disabled: boolean;
  onClose: (id: string) => void;
  onUnpin: (id: string) => void;
}): JSX.Element {
  const L = useVocabOptional();
  const label = pinned ? L.dockUnpinTab : L.dockCloseTab;
  const marker = pinned ? { 'data-unpin-tab': id } : { 'data-close-tab': id };
  return (
    <button type="button" className={pinned ? 'dock-control dock-tab-pin' : 'dock-control dock-tab-close'} disabled={disabled}
      {...marker} title={label} aria-label={label} onPointerDown={(event) => event.stopPropagation()}
      onClick={() => (pinned ? onUnpin(id) : onClose(id))}>
      {pinned ? <PinGlyph size={11} /> : <CloseGlyph size={10} />}
    </button>
  );
}

/** The ✕ as line art, for the tab close and the dock close: centred, weight independent of the font. */
export function CloseGlyph({ size = 13 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" aria-hidden="true" style={{ display: 'block', flex: 'none' }}>
      <path d="m3.5 3.5 9 9m0-9-9 9" />
    </svg>
  );
}

/** One small muted glyph per kind. The board's flag also names the kind for assistive tech, since its
 *  label is only the board's title; a file name and a web address speak for themselves. */
function TabIcon({ tab, copy }: { tab: DockTab; copy: Pick<Vocab, 'boardTitle'> }): JSX.Element {
  if (isBoardTab(tab)) {
    return <span className="dock-tab-icon" role="img" aria-label={copy.boardTitle}><BoardIcon size={13} /></span>;
  }
  return (
    <span className="dock-tab-icon" aria-hidden="true">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
        {isFileTab(tab)
          ? <><path d="M4 2.5h5l3 3v8H4z" /><path d="M9 2.5v3h3" /></>
          : isAgentBrowserTab(tab)
            ? <><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M2 6h12M7.5 8.5l2.5 2.5M7.5 8.5v3l1-1" /></>
            : <><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.6 1.6 2.4 3.4 2.4 5.5S9.6 11.9 8 13.5C6.4 11.9 5.6 10.1 5.6 8S6.4 4.1 8 2.5z" /></>}
      </svg>
    </span>
  );
}

function tabTooltip(tab: Exclude<DockTab, { kind: 'board' } | { kind: 'agent-browser' }>, label: string, source: string | null, copy: Pick<Vocab, 'brForwardedFrom'>): string {
  if (isFileTab(tab)) return tab.item.path ?? label;
  if (source) return `${label}\n${copy.brForwardedFrom.replace('{source}', source)}`;
  const url = currentUrl(tab.history);
  return url ?? label;
}

/** Where a web tab points, after its label: the port its URL carries (the label already dropped it)
 *  or a forward's original `device:port`. Quiet text rather than a chip; a forward keeps
 *  data-forward-source — provenance the address bar cannot show. A bare port reads straight on from
 *  an untitled tab's host (`localhost:8080`); after a page title or a forward it stands apart. */
function TabWhere({ tab, chip, source, copy }: {
  tab: WebDockTab;
  chip: BrowserTabChip;
  source: string | null;
  copy: Pick<Vocab, 'brForwardedFrom'>;
}): JSX.Element {
  const forwarded = chip.kind === 'forward' && source !== null;
  const attached = chip.kind === 'plain' && tab.pageTitle === null;
  return (
    <span className="dock-tab-where" data-tab-where={chip.kind} data-attached={attached ? 'true' : undefined}
      {...(forwarded ? { 'data-forward-source': source } : {})}
      title={forwarded ? copy.brForwardedFrom.replace('{source}', source) : undefined}>{chip.text}</span>
  );
}

function motionReduction(mode: MotionMode): 'always' | 'never' | 'user' {
  if (mode === 'reduced') return 'always';
  if (mode === 'full') return 'never';
  return 'user';
}

const TAB_LABEL_STYLE: CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: '16px' };
