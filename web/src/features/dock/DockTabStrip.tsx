// input:  the dock tab list, motion preferences and tab intents
// output: one sortable strip mixing file previews and web pages
// pos:    Dock chrome; the only place a tab's kind becomes a label and a chip
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { forwardRef, type CSSProperties, type ReactNode } from 'react';
import { AnimatePresence, MotionConfig, Reorder, motion, useIsPresent, useReducedMotion } from 'motion/react';
import { useMotionMode, type MotionMode } from '@/theme';
import {
  browserTabChip,
  browserTabForwardSource,
  currentUrl,
  type BrowserTabChip,
} from '@/features/browser/browser-target';
import { attachmentFileExt } from '@/features/workbench/attachment-presentation';
import { dockTabLabel, isFileTab, type DockState, type DockTab } from './dock-tabs';

// The strip is 50px tall so it lines up with the chat header across the divider, and its tabs hang
// off the bottom edge: the active tab's own bottom border is painted in the body colour and pulled
// 1px down over the strip's rule, which is what makes it read as continuous with its body.

const MONO = "'IBM Plex Mono',monospace";

export function DockTabStrip({ state, onAdd, onSelect, onClose, onReorder, actions }: {
  state: DockState | null;
  onAdd: () => void;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (orderedIds: string[]) => void;
  /** Right-aligned controls that belong to the dock, not to any one tab. */
  actions?: ReactNode;
}): JSX.Element {
  const motionMode = useMotionMode();
  const systemReduced = useReducedMotion();
  const reduceMotion = motionMode === 'reduced' || (motionMode === 'system' && systemReduced === true);
  const tabs = state?.tabs ?? [];
  return (
    <MotionConfig reducedMotion={motionReduction(motionMode)}>
      <div style={STRIP_ROW_STYLE}>
        <Reorder.Group
          as="div"
          axis="x"
          values={tabs.map((tab) => tab.id)}
          onReorder={onReorder}
          layoutScroll
          style={STRIP_SCROLL_STYLE}
        >
          <AnimatePresence initial={false} mode="popLayout">
            {tabs.map((tab) => (
              <DockTabItem
                key={tab.id}
                tab={tab}
                active={tab.id === state?.activeId}
                draggable={tabs.length > 1}
                reduceMotion={reduceMotion}
                onSelect={onSelect}
                onClose={onClose}
              />
            ))}
          </AnimatePresence>
          <motion.button layout type="button" data-add-tab="" title="New tab" onClick={onAdd} style={ADD_BUTTON_STYLE}>+</motion.button>
        </Reorder.Group>
        {actions && <div style={ACTIONS_STYLE}>{actions}</div>}
      </div>
    </MotionConfig>
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

const DockTabItem = forwardRef<HTMLDivElement, DockTabItemProps>(function DockTabItem(
  { tab, active, draggable, reduceMotion, onSelect, onClose }, ref,
): JSX.Element {
  const label = dockTabLabel(tab);
  const source = isFileTab(tab) ? null : browserTabForwardSource(tab);
  const chip = tabChip(tab);
  const tooltip = tabTooltip(tab, label, source);
  const isPresent = useIsPresent();
  return (
    <Reorder.Item
      ref={ref}
      as="div"
      value={tab.id}
      dragListener={draggable && isPresent}
      dragElastic={0.08}
      initial={reduceMotion ? false : { opacity: 0, scale: 0.94 }}
      animate={reduceMotion ? undefined : { opacity: 1, scale: 1 }}
      exit={reduceMotion ? undefined : { opacity: 0, scale: 0.94, transition: { duration: 0.12, ease: 'easeIn' } }}
      transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 40, opacity: { duration: 0.12 }, scale: { duration: 0.14 } }}
      whileDrag={reduceMotion ? undefined : { scale: 1.03 }}
      style={{
        ...TAB_ITEM_STYLE,
        pointerEvents: isPresent ? 'auto' : 'none',
        borderBottomColor: active ? 'var(--proto-card)' : 'var(--proto-line)',
        background: active ? 'var(--proto-card)' : 'var(--proto-gray)',
      }}
    >
      <button
        type="button"
        aria-pressed={active}
        data-dock-tab={tab.id}
        data-tab-kind={tab.kind}
        data-active={active ? 'true' : 'false'}
        onClick={() => onSelect(tab.id)}
        title={tooltip}
        style={{ ...TAB_SELECT_STYLE, color: active ? 'var(--proto-ink)' : 'var(--proto-muted)' }}
      >
        {chip && <TabChip chip={chip} source={source} />}
        <span style={TAB_LABEL_STYLE}>{label}</span>
      </button>
      <button
        type="button"
        disabled={!isPresent}
        data-close-tab={tab.id}
        title="Close tab"
        aria-label="Close tab"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => onClose(tab.id)}
        style={TAB_CLOSE_STYLE}
      >×</button>
    </Reorder.Item>
  );
});

/** Every tab carries the same chip shape, so the strip stays one rhythm: a web tab shows its port
 *  (or the device:port it was forwarded from), a file tab shows its extension. */
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

/** The forward chip keeps `data-forward-source` — provenance the address bar cannot show. */
function TabChip({ chip, source }: { chip: BrowserTabChip; source: string | null }): JSX.Element {
  const forwarded = chip.kind === 'forward' && source !== null;
  return (
    <span
      {...(forwarded ? { 'data-forward-source': source } : {})}
      title={forwarded ? `Forwarded from ${source}` : undefined}
      style={forwarded ? TAB_CHIP_FORWARD_STYLE : TAB_CHIP_PLAIN_STYLE}
    >{chip.text}</span>
  );
}

function motionReduction(mode: MotionMode): 'always' | 'never' | 'user' {
  if (mode === 'reduced') return 'always';
  if (mode === 'full') return 'never';
  return 'user';
}

const STRIP_ROW_STYLE: CSSProperties = { height: 50, flex: 'none', display: 'flex', alignItems: 'stretch', background: 'var(--proto-gray)', borderBottom: '1px solid var(--proto-line)' };
const STRIP_SCROLL_STYLE: CSSProperties = { flex: 1, minWidth: 0, display: 'flex', alignItems: 'flex-end', gap: 3, padding: '0 0 0 8px', overflowX: 'auto', position: 'relative' };
const ACTIONS_STYLE: CSSProperties = { flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px' };
const TAB_ITEM_STYLE: CSSProperties = { display: 'flex', alignItems: 'center', flex: 'none', minWidth: 96, maxWidth: 210, height: 34, marginBottom: -1, border: '1px solid var(--proto-line)', borderRadius: '7px 7px 0 0', position: 'relative', cursor: 'grab', overflow: 'hidden', transition: 'background-color 140ms ease, border-color 140ms ease' };
const TAB_SELECT_STYLE: CSSProperties = { display: 'flex', alignItems: 'center', minWidth: 0, height: '100%', flex: 1, padding: '0 2px 0 7px', border: 'none', background: 'transparent', font: `500 10px ${MONO}`, cursor: 'inherit', transition: 'color 140ms ease', textAlign: 'left' };
const TAB_LABEL_STYLE: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: '13px' };
const TAB_CHIP_STYLE: CSSProperties = { display: 'inline-flex', alignItems: 'center', flex: 'none', maxWidth: 98, height: 16, padding: '0 5px', marginRight: 6, borderRadius: 5, font: `600 9px ${MONO}`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const TAB_CHIP_FORWARD_STYLE: CSSProperties = { ...TAB_CHIP_STYLE, background: 'var(--proto-accent-bg)', color: 'var(--proto-accent)' };
const TAB_CHIP_PLAIN_STYLE: CSSProperties = { ...TAB_CHIP_STYLE, border: '1px solid var(--proto-line)', color: 'var(--proto-muted-2)' };
const TAB_CLOSE_STYLE: CSSProperties = { width: 24, height: '100%', flex: 'none', border: 'none', background: 'transparent', color: 'var(--proto-muted-2)', font: `500 13px ${MONO}`, lineHeight: 1, cursor: 'pointer', padding: 0 };
const ADD_BUTTON_STYLE: CSSProperties = { width: 26, height: 26, flex: 'none', marginBottom: 4, borderRadius: '7px 7px 0 0', border: '1px solid var(--proto-line)', background: 'var(--proto-card)', color: 'var(--proto-muted)', font: `500 13px ${MONO}`, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 };
