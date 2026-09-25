// input:  React, mobile kit, presentation props
// output: BottomTabBar
// pos:    Readable floating mobile tab navigation
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { type ReactNode } from 'react';
import { MOBILE_TABS, tabBadge, type MobileTabId } from './mobile-tabs';
import { MONO, M_TABBAR_BOTTOM } from '@/design/mobile-tokens';
import { type Vocab } from '@/i18n';

const ACTIVE = 'var(--proto-accent)';
const IDLE = 'var(--m-muted)';

function TabIcon({ id, color }: { id: MobileTabId; color: string }): ReactNode {
  switch (id) {
    case 'sessions':
      return (
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke={color} strokeWidth="1.7">
          <path d="M4 4.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H9.5L5.5 19v-3.5H4A1.5 1.5 0 0 1 2.5 14V6A1.5 1.5 0 0 1 4 4.5z" />
        </svg>
      );
    case 'threads':
      return (
        <svg width="22" height="22" viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth="1.4">
          <circle cx="3.5" cy="3" r="1.9" />
          <circle cx="3.5" cy="11" r="1.9" />
          <circle cx="10.5" cy="7" r="1.9" />
          <path d="M3.5 5v4M5.4 3.7 8.7 6.1M5.4 10.3 8.7 7.9" />
        </svg>
      );
    case 'tasks':
      return (
        <svg width="22" height="22" viewBox="0 0 20 20" fill="none" stroke={color} strokeWidth="1.6">
          <path d="M4 5.5l1.5 1.5L8 4.5" />
          <path d="M4 12.5l1.5 1.5L8 11.5" />
          <path d="M10.5 6h6M10.5 13h6" />
        </svg>
      );
    case 'project':
      // Folder icon (scheme 1a L125): the 项目 tab.
      return (
        <svg width="22" height="22" viewBox="0 0 20 20" fill="none" stroke={color} strokeWidth="1.6">
          <path d="M3 5.5h5l1.5 2H17a1 1 0 0 1 1 1V15a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
        </svg>
      );
  }
}

export interface BottomTabBarProps {
  vocab: Vocab;
  activeId: MobileTabId;
  /** 需要你 count → amber badge on the 项目 tab (pending approvals). */
  needsYouCount: number;
  onNavigate: (path: string) => void;
}

export function BottomTabBar({ vocab, activeId, needsYouCount, onNavigate }: BottomTabBarProps) {
  return (
    <div
      style={{
        position: 'absolute',
        left: 14,
        right: 14,
        bottom: M_TABBAR_BOTTOM,
        height: 62,
        borderRadius: 22,
        // One of the three places on mobile that may blur (see MC's blur budget): the Tab bar is
        // fixed chrome that never scrolls and never repaints, so the ground behind it is sampled
        // once rather than once per frame.
        background: 'var(--glass-1)',
        backdropFilter: 'var(--glass-filter)',
        WebkitBackdropFilter: 'var(--glass-filter)',
        boxShadow: '0 0 0 1px var(--proto-line), var(--shadow-chrome-float)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-around',
        padding: '0 6px',
        zIndex: 6,
      }}
    >
      {MOBILE_TABS.map((tab) => {
        const active = tab.id === activeId;
        const color = active ? ACTIVE : IDLE;
        const badge = tabBadge(tab.id, { needsYouCount });
        return (
          <button
            key={tab.id}
            type="button"
            data-tab-id={tab.id}
            data-active={active ? 'true' : 'false'}
            aria-current={active ? 'page' : undefined}
            onClick={() => onNavigate(tab.path)}
            style={{
              minWidth: 64,
              flex: 'none',
              minHeight: 44,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 3,
              border: 'none',
              background: 'transparent',
              padding: 0,
              cursor: 'pointer',
            }}
          >
            <div style={{ position: 'relative' }}>
              <TabIcon id={tab.id} color={color} />
              {badge.count !== undefined && (
                <span
                  style={{
                    position: 'absolute',
                    top: -4,
                    right: -10,
                    minWidth: 16,
                    height: 16,
                    padding: '0 4px',
                    boxSizing: 'border-box',
                    borderRadius: 'var(--r-pill)',
                    // Amber, not accent: this is the pending-approvals count — the app's「需要你」colour.
                    background: 'var(--proto-amber)',
                    color: 'var(--amber-fill-fg)',
                    font: `600 11px ${MONO}`,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {badge.count}
                </span>
              )}
            </div>
            <span style={{ fontSize: 11, fontWeight: active ? 600 : 500, color }}>
              {vocab[tab.labelKey]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
