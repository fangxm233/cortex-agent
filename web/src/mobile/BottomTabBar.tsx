// @ds-adherence-ignore -- mobile bottom Tab bar, 1:1 from scheme.dc.html L2995-3000 / L3188-3191
// (raw px/hex/svg by design, §8.3; mobile palette is not in the light `proto.*` token set).
import { type ReactNode } from 'react';
import { MOBILE_TABS, tabBadge, type MobileTabId } from './mobile-tabs';
import { type Vocab } from '@/i18n';

const INK = '#191C22';
const MUTED = '#98A1B0';

function TabIcon({ id, color }: { id: MobileTabId; color: string }): ReactNode {
  switch (id) {
    case 'sessions':
      return (
        <svg width="21" height="21" viewBox="0 0 22 22" fill="none" stroke={color} strokeWidth="1.7">
          <path d="M4 4.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H9.5L5.5 19v-3.5H4A1.5 1.5 0 0 1 2.5 14V6A1.5 1.5 0 0 1 4 4.5z" />
        </svg>
      );
    case 'threads':
      return (
        <svg width="20" height="20" viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth="1.4">
          <circle cx="3.5" cy="3" r="1.9" />
          <circle cx="3.5" cy="11" r="1.9" />
          <circle cx="10.5" cy="7" r="1.9" />
          <path d="M3.5 5v4M5.4 3.7 8.7 6.1M5.4 10.3 8.7 7.9" />
        </svg>
      );
    case 'tasks':
      return (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke={color} strokeWidth="1.6">
          <path d="M4 5.5l1.5 1.5L8 4.5" />
          <path d="M4 12.5l1.5 1.5L8 11.5" />
          <path d="M10.5 6h6M10.5 13h6" />
        </svg>
      );
    case 'machines':
      return (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke={color} strokeWidth="1.6">
          <rect x="3" y="4" width="14" height="5" rx="1.5" />
          <rect x="3" y="11" width="14" height="5" rx="1.5" />
          <circle cx="6" cy="6.5" r="0.9" fill={color} stroke="none" />
          <circle cx="6" cy="13.5" r="0.9" fill={color} stroke="none" />
        </svg>
      );
  }
}

export interface BottomTabBarProps {
  vocab: Vocab;
  activeId: MobileTabId;
  activeThreadCount: number;
  hasPendingApproval: boolean;
  onNavigate: (path: string) => void;
}

export function BottomTabBar({
  vocab,
  activeId,
  activeThreadCount,
  hasPendingApproval,
  onNavigate,
}: BottomTabBarProps) {
  return (
    <div
      style={{
        flex: 'none',
        borderTop: '1px solid #E7E9EE',
        background: '#FBFBFC',
        display: 'flex',
        // Reserve the OS home-indicator gutter (env bottom inset) below the 8px base padding.
        padding: '8px 6px',
        paddingBottom: 'calc(8px + env(safe-area-inset-bottom))',
      }}
    >
      {MOBILE_TABS.map((tab) => {
        const active = tab.id === activeId;
        const color = active ? INK : MUTED;
        const badge = tabBadge(tab.id, { activeThreadCount, hasPendingApproval });
        return (
          <button
            key={tab.id}
            type="button"
            data-tab-id={tab.id}
            data-active={active ? 'true' : 'false'}
            aria-current={active ? 'page' : undefined}
            onClick={() => onNavigate(tab.path)}
            style={{
              flex: 1,
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
                    right: -9,
                    background: '#4655D4',
                    color: '#fff',
                    font: "600 8px 'IBM Plex Mono', monospace",
                    padding: '1px 4.5px',
                    borderRadius: 999,
                  }}
                >
                  {badge.count}
                </span>
              )}
              {badge.dot && (
                <span
                  style={{
                    position: 'absolute',
                    top: -2,
                    right: -4,
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: '#C99A2E',
                  }}
                />
              )}
            </div>
            <span style={{ fontSize: 10, fontWeight: 600, color }}>{vocab[tab.labelKey]}</span>
          </button>
        );
      })}
    </div>
  );
}
