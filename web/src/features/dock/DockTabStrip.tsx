// input:  dock-tabs, browser-target, motion, theme
// output: DockTabStrip
// pos:    Compact glass tabs above stable dock documents
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { forwardRef, type CSSProperties, type ReactNode } from 'react';
import { AnimatePresence, MotionConfig, Reorder, motion, useIsPresent, useReducedMotion } from 'motion/react';
import { useMotionMode, type MotionMode } from '@/theme';
import { browserTabChip, browserTabForwardSource, currentUrl, type BrowserTabChip } from '@/features/browser/browser-target';
import { attachmentFileExt } from '@/features/workbench/attachment-presentation';
import { dockTabLabel, isFileTab, type DockState, type DockTab } from './dock-tabs';
import './dock-chrome.css';

// Keep the strip at the chat header's 50px height. Only chrome reorders; the pane's
// insertion-ordered bodies remain mounted. The scroller clips vertical drag overflow.
const MONO = "'IBM Plex Mono',monospace";

interface StripProps {
  state: DockState | null;
  onAdd: () => void;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (orderedIds: string[]) => void;
  /** Right-aligned controls that belong to the dock, not to any one tab. */
  actions?: ReactNode;
}

export function DockTabStrip(props: StripProps): JSX.Element {
  const motionMode = useMotionMode();
  const systemReduced = useReducedMotion();
  const reduceMotion = motionMode === 'reduced' || (motionMode === 'system' && systemReduced === true);
  return (
    <MotionConfig reducedMotion={motionReduction(motionMode)}>
      <div className="dock-strip">
        <TabScroller {...props} reduceMotion={reduceMotion} />
        {props.actions && <div className="dock-tab-actions">{props.actions}</div>}
      </div>
    </MotionConfig>
  );
}

function TabScroller({ state, onAdd, onSelect, onClose, onReorder, reduceMotion }: StripProps & { reduceMotion: boolean }): JSX.Element {
  const tabs = state?.tabs ?? [];
  return (
    <Reorder.Group as="div" axis="x" values={tabs.map((tab) => tab.id)} onReorder={onReorder} layoutScroll className="dock-tab-scroll">
      <AnimatePresence initial={false} mode="popLayout">
        {tabs.map((tab) => <DockTabItem key={tab.id} tab={tab} active={tab.id === state?.activeId}
          draggable={tabs.length > 1} reduceMotion={reduceMotion} onSelect={onSelect} onClose={onClose} />)}
      </AnimatePresence>
      <motion.button layout type="button" className="dock-control" data-add-tab="" title="New tab" aria-label="New tab" onClick={onAdd}>+</motion.button>
    </Reorder.Group>
  );
}

interface DockTabItemProps {
  tab: DockTab;
  active: boolean;
  draggable: boolean;
  reduceMotion: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

const DockTabItem = forwardRef<HTMLDivElement, DockTabItemProps>(function DockTabItem(props, ref): JSX.Element {
  const { tab, active, draggable, reduceMotion } = props;
  const isPresent = useIsPresent();
  return (
    <Reorder.Item ref={ref} as="div" value={tab.id} dragListener={draggable && isPresent} dragElastic={0.08}
      initial={reduceMotion ? false : { opacity: 0, scale: 0.94 }}
      animate={reduceMotion ? undefined : { opacity: 1, scale: 1 }}
      exit={reduceMotion ? undefined : { opacity: 0, scale: 0.94, transition: { duration: 0.12, ease: 'easeIn' } }}
      transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 40, opacity: { duration: 0.12 }, scale: { duration: 0.14 } }}
      whileDrag={reduceMotion ? undefined : { scale: 1.03 }}
      className="dock-tab-item" data-selected={active} style={{ pointerEvents: isPresent ? 'auto' : 'none' }}>
      <TabButtons {...props} isPresent={isPresent} />
    </Reorder.Item>
  );
});

function TabButtons({ tab, active, onSelect, onClose, isPresent }: DockTabItemProps & { isPresent: boolean }): JSX.Element {
  const label = dockTabLabel(tab);
  const source = isFileTab(tab) ? null : browserTabForwardSource(tab);
  const chip = tabChip(tab);
  return (
    <>
      <button type="button" className="dock-tab-select" aria-pressed={active} data-dock-tab={tab.id}
        data-tab-kind={tab.kind} data-active={active ? 'true' : 'false'} onClick={() => onSelect(tab.id)} title={tabTooltip(tab, label, source)}>
        {chip && <TabChip chip={chip} source={source} />}
        <span style={TAB_LABEL_STYLE}>{label}</span>
      </button>
      <button type="button" className="dock-control dock-tab-close" disabled={!isPresent} data-close-tab={tab.id}
        title="Close tab" aria-label="Close tab" onPointerDown={(event) => event.stopPropagation()} onClick={() => onClose(tab.id)}>×</button>
    </>
  );
}

/** Every tab carries the same chip shape: a web port or device, or a file extension. */
function tabChip(tab: DockTab): BrowserTabChip | null {
  if (!isFileTab(tab)) return browserTabChip(tab);
  return { text: attachmentFileExt(tab.item.name), kind: 'plain' };
}

function tabTooltip(tab: DockTab, label: string, source: string | null): string {
  if (isFileTab(tab)) return tab.item.path ?? label;
  if (source) return `${label}\nForwarded from ${source}`;
  const url = currentUrl(tab.history);
  return url ?? label;
}

/** The forward chip keeps data-forward-source — provenance the address bar cannot show. */
function TabChip({ chip, source }: { chip: BrowserTabChip; source: string | null }): JSX.Element {
  const forwarded = chip.kind === 'forward' && source !== null;
  return (
    <span {...(forwarded ? { 'data-forward-source': source } : {})}
      title={forwarded ? `Forwarded from ${source}` : undefined}
      style={forwarded ? TAB_CHIP_FORWARD_STYLE : TAB_CHIP_PLAIN_STYLE}>{chip.text}</span>
  );
}

function motionReduction(mode: MotionMode): 'always' | 'never' | 'user' {
  if (mode === 'reduced') return 'always';
  if (mode === 'full') return 'never';
  return 'user';
}

const TAB_LABEL_STYLE: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: '15px' };
const TAB_CHIP_STYLE: CSSProperties = { display: 'inline-flex', alignItems: 'center', flex: 'none', maxWidth: 98, height: 18, padding: '0 5px', marginRight: 6, borderRadius: 'var(--r-chip)', font: `600 11px ${MONO}`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const TAB_CHIP_FORWARD_STYLE: CSSProperties = { ...TAB_CHIP_STYLE, background: 'var(--proto-accent-bg)', color: 'var(--proto-accent)' };
const TAB_CHIP_PLAIN_STYLE: CSSProperties = { ...TAB_CHIP_STYLE, border: '1px solid var(--proto-line)', color: 'var(--proto-muted)' };
