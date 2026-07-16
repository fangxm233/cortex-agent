// @ds-adherence-ignore -- mobile v3 raw px/hex/font by design §8.3 (scheme-mobile.dc.html 1l L601-663)
import { type ReactNode } from 'react';
import { MDrillHeader, MScrollBody, MC, MONO } from '@/mobile/ui/kit';
import { BUILD_STAMP } from '@/lib/build-info';
import type { MSettingsVm } from './m-settings-vm';

export interface MSettingsCopy {
  title: string;
  daemonStatus: string; // header trailing `daemon · 已连接`
  daemon: string;
  profileTitle: string; // `Profile（全局默认）`
  profileTail: string; // `会话级切换在 chat 内 chip`
  switchLabel: string; // `切换`
  budget: string;
  budgetUnit: string; // `日`
  notify: string;
  notifySub: string;
  autoResume: string;
  autoResumeSub: string;
  platform: string; // `Platform`
  desktopEdit: string; // `桌面编辑`
  templates: string; // `Thread templates`
  hooks: string; // `Hooks · 三层只读`
  footerBrand: string; // `cortex mobile`
  footerHot: string; // `配置热更新 · 免重启`
}

// ── header trailing: daemon · 已连接 (scheme L607) ─────────────────────────────
function DaemonStatus({ copy }: { copy: MSettingsCopy }) {
  return (
    <span
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 10,
        color: MC.done,
        fontWeight: 600,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: MC.done }} />
      {copy.daemonStatus}
    </span>
  );
}

// ── a white rounded card that hosts divider-separated rows (scheme card pattern) ──
function Card({ children, opacity }: { children: ReactNode; opacity?: number }) {
  return (
    <div
      style={{
        background: '#fff',
        border: `1px solid ${MC.hairline}`,
        borderRadius: 13,
        overflow: 'hidden',
        opacity,
      }}
    >
      {children}
    </div>
  );
}

function rowStyle(divider: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '12px 13px',
    borderBottom: divider ? `1px solid ${MC.divider}` : undefined,
  };
}

const TITLE: React.CSSProperties = { fontSize: 14, fontWeight: 600, color: MC.ink };
const SUB: React.CSSProperties = { font: `400 10px ${MONO}`, color: MC.muted, marginTop: 2 };
const CHEV: React.CSSProperties = { fontSize: 13, color: MC.faint, flex: 'none' };

// ── the read-only toggle (scheme L639/L648): reflects env presence, inert (no .env config.set) ──
function ReadOnlyToggle({ on, label }: { on: boolean; label: string }) {
  // GAP: no config.set for this .env flag → the toggle reflects real presence but is NON-writable.
  return (
    <div
      role="switch"
      aria-checked={on}
      aria-readonly
      aria-label={label}
      title="Reflects the real env flag — read-only (no config.set for .env)"
      style={{
        width: 44,
        height: 26,
        borderRadius: 999,
        background: on ? MC.done : '#D9DCE3',
        position: 'relative',
        flex: 'none',
        cursor: 'default',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          [on ? 'right' : 'left']: 2,
          width: 22,
          height: 22,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 3px rgba(16,24,40,.2)',
        }}
      />
    </div>
  );
}

// ── the `桌面编辑` inert pill (scheme L657-658) ───────────────────────────────
function DesktopPill({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        marginLeft: 'auto',
        fontSize: 9.5,
        fontWeight: 600,
        padding: '1.5px 7px',
        borderRadius: 999,
        background: MC.gray,
        color: MC.grayInk,
        flex: 'none',
      }}
    >
      {children}
    </span>
  );
}

export function MSettingsView({
  vm,
  copy,
  onBack,
  onOpenDaemon,
}: {
  vm: MSettingsVm;
  copy: MSettingsCopy;
  onBack: () => void;
  onOpenDaemon: () => void;
}) {
  const profileSub = [vm.profileName, vm.profileModel].filter(Boolean).join(' · ');
  const platformLabel =
    copy.platform + (vm.platforms.length ? `（${vm.platforms.join(', ')}）` : '');
  return (
    <>
      <MDrillHeader onBack={onBack} trailing={<DaemonStatus copy={copy} />}>
        <div style={{ fontSize: 16, fontWeight: 650, color: MC.ink, letterSpacing: '-.01em' }}>
          {copy.title}
        </div>
      </MDrillHeader>
      <MScrollBody gap={10}>
        {/* card1 — Daemon · Profile */}
        <Card>
          <div style={rowStyle(true)} onClick={onOpenDaemon}>
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 9,
                background: MC.doneBg,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flex: 'none',
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: MC.done }} />
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={TITLE}>{copy.daemon}</div>
              {/* GAP: config.get carries no host / uptime → sub omitted rather than fabricated. */}
              {vm.daemonHost && <div style={SUB}>{vm.daemonHost}</div>}
            </div>
            <span style={{ ...CHEV, cursor: 'pointer' }}>›</span>
          </div>
          <div style={rowStyle(false)}>
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 9,
                background: MC.runBg,
                color: MC.run,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                font: `600 11px ${MONO}`,
                flex: 'none',
              }}
            >
              P
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={TITLE}>{copy.profileTitle}</div>
              <div style={SUB}>{profileSub ? `${profileSub} · ${copy.profileTail}` : copy.profileTail}</div>
            </div>
            {/* GAP: profile switch is desktop-only here → inert accent label (no config.set wired). */}
            <span style={{ font: `500 10px ${MONO}`, color: MC.run, flex: 'none' }}>
              {copy.switchLabel}
            </span>
          </div>
        </Card>

        {/* card2 — 预算 · 通知 · 限额自动续跑 */}
        <Card>
          <div style={{ ...rowStyle(true), gap: 0 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={TITLE}>{copy.budget}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <div
                  style={{
                    flex: 1,
                    height: 5,
                    borderRadius: 999,
                    background: '#EFF1F5',
                    overflow: 'hidden',
                  }}
                >
                  <div style={{ width: vm.budgetBarPct, height: '100%', background: MC.run }} />
                </div>
                <span style={{ font: `500 10px ${MONO}`, color: MC.ink, flex: 'none' }}>
                  {vm.budgetSpendLabel} {copy.budgetUnit}
                </span>
              </div>
            </div>
            <span style={{ ...CHEV, paddingLeft: 10 }}>›</span>
          </div>
          <div style={rowStyle(true)}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={TITLE}>{copy.notify}</div>
              <div style={SUB}>{copy.notifySub}</div>
            </div>
            <ReadOnlyToggle on={vm.notifyOn} label={copy.notify} />
          </div>
          <div style={rowStyle(false)}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={TITLE}>{copy.autoResume}</div>
              <div style={SUB}>{copy.autoResumeSub}</div>
            </div>
            <ReadOnlyToggle on={vm.autoResumeOn} label={copy.autoResume} />
          </div>
        </Card>

        {/* card3 — Platform · Templates · Hooks (desktop-only editing, opacity .92) */}
        <Card opacity={0.92}>
          <div style={{ ...rowStyle(true), gap: 9 }}>
            <span style={{ fontSize: 13, color: MC.sub }}>{platformLabel}</span>
            <DesktopPill>{copy.desktopEdit}</DesktopPill>
            <span style={CHEV}>›</span>
          </div>
          <div style={{ ...rowStyle(true), gap: 9 }}>
            <span style={{ fontSize: 13, color: MC.sub }}>
              {copy.templates} · {vm.templatesCount}
            </span>
            <DesktopPill>{copy.desktopEdit}</DesktopPill>
            <span style={CHEV}>›</span>
          </div>
          <div style={{ ...rowStyle(false), gap: 9 }}>
            <span style={{ fontSize: 13, color: MC.sub }}>{copy.hooks}</span>
            <span style={{ ...CHEV, marginLeft: 'auto' }}>›</span>
          </div>
        </Card>

        {/* footer — brand · build stamp · hot-reload. The scheme's `v0.4.2` slot is filled with the
            real build stamp (Vite-injected, see lib/build-info.ts): it changes every build, so an OTA
            frontend swap is verifiable on-device by watching this value change. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            padding: '2px 4px',
            font: `400 9.5px ${MONO}`,
            color: MC.faint,
          }}
        >
          <span>{copy.footerBrand}</span>
          <span style={{ marginLeft: 'auto' }}>build {BUILD_STAMP} · {copy.footerHot}</span>
        </div>
      </MScrollBody>
    </>
  );
}
