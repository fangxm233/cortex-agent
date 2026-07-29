// input:  mobile settings view model, copy, and UI primitives
// output: read-only mobile settings screen with a hooks drill-in row
// pos:    Presentational mobile settings view
// >>> If I am updated, update my header comment and CORTEX.md <<<

// @ds-adherence-ignore -- mobile v3 raw px/hex/font by design §8.3 (scheme-mobile.dc.html 1l L601-663)
import { type ReactNode } from 'react';
import { MDrillHeader, MScrollBody, MBottomSheet, MC, MONO } from '@/mobile/ui/kit';
import { BUILD_STAMP } from '@/lib/build-info';
import type { Lang } from '@/i18n';
import type { Theme } from '@/theme';
import type { MSettingsVm } from './m-settings-vm';
import type { ProfileSheetItem } from './m-chat-vm';

export interface MSettingsCopy {
  title: string;
  daemonStatus: string; // header trailing `daemon · 已连接`
  daemon: string;
  profileTitle: string; // `Profile（全局默认）`
  switchLabel: string; // `切换`
  profileSheetTitle: string; // `全局默认 Profile`
  profileSheetCurrent: string; // `当前`
  profileSheetFooter: string; // `切换后新会话 / 新线程使用`
  theme: string; // `主题`
  themeLight: string; // `浅色`
  themeDark: string; // `深色`
  budget: string;
  budgetUnit: string; // `日`
  notify: string;
  notifySub: string;
  autoResume: string;
  autoResumeSub: string;
  language: string; // `语言`
  platform: string; // `Platform`
  desktopEdit: string; // `桌面编辑`
  templates: string; // `Thread templates`
  hooks: string; // `Hooks`, rendered as `Hooks · N` on the drill-in row
  footerBrand: string; // `cortex mobile`
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
        background: MC.card,
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
        background: on ? MC.done : 'var(--proto-line-3)',
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
          background: 'var(--ink-solid-bg)',
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

// ── A generic two-option segmented toggle (mirrors the desktop LeftRail footer toggle). The active
//    segment is the ink-solid inverse chip (light-bg/dark-fg in dark mode). ───────────────────────
function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      style={{
        display: 'flex',
        border: `1px solid ${MC.hairline}`,
        borderRadius: 6,
        overflow: 'hidden',
        flex: 'none',
      }}
    >
      {options.map((o) => {
        const active = value === o.id;
        return (
          <span
            key={o.id}
            role="button"
            aria-pressed={active}
            onClick={() => onChange(o.id)}
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: '3px 10px',
              cursor: 'pointer',
              background: active ? 'var(--ink-solid-bg)' : 'transparent',
              color: active ? 'var(--ink-solid-fg)' : MC.muted,
            }}
          >
            {o.label}
          </span>
        );
      })}
    </div>
  );
}

function LangToggle({ lang, onSetLang }: { lang: Lang; onSetLang: (l: Lang) => void }) {
  return (
    <Segmented
      ariaLabel="Language"
      value={lang}
      options={[
        { id: 'en', label: 'EN' },
        { id: 'zh', label: '中' },
      ]}
      onChange={onSetLang}
    />
  );
}

function ThemeToggle({
  theme,
  onSetTheme,
  lightLabel,
  darkLabel,
}: {
  theme: Theme;
  onSetTheme: (t: Theme) => void;
  lightLabel: string;
  darkLabel: string;
}) {
  return (
    <Segmented
      ariaLabel="Theme"
      value={theme}
      options={[
        { id: 'light', label: lightLabel },
        { id: 'dark', label: darkLabel },
      ]}
      onChange={onSetTheme}
    />
  );
}

// ── Hooks: one drill-in row into /m/settings/hooks (plan §6) ──────────────────
// The count is the cheap 4-field `config.get` summary already loaded for this screen; the full
// declarations (matcher, run, mounts, script health) are fetched by the hooks screen itself.
// Inlining them here made the page unusable at 17 entries and worse once a user registry grows.
function HooksDrillRow({ vm, copy, onOpenHooks }: { vm: MSettingsVm; copy: MSettingsCopy; onOpenHooks: () => void }) {
  return (
    <div
      role="button"
      aria-label={copy.hooks}
      onClick={onOpenHooks}
      style={{ ...rowStyle(false), gap: 9, cursor: 'pointer' }}
    >
      <span style={{ fontSize: 13, color: MC.sub }}>
        {copy.hooks} · {vm.hooks.length}
      </span>
      <DesktopPill>{copy.desktopEdit}</DesktopPill>
      <span style={CHEV}>›</span>
    </div>
  );
}

export function MSettingsView({
  vm,
  copy,
  lang,
  onSetLang,
  theme,
  onSetTheme,
  onBack,
  onOpenDaemon,
  onOpenHooks,
  profileSheet,
  onOpenProfile,
  onCloseProfile,
  onPickProfile,
}: {
  vm: MSettingsVm;
  copy: MSettingsCopy;
  lang: Lang;
  onSetLang: (lang: Lang) => void;
  theme: Theme;
  onSetTheme: (theme: Theme) => void;
  onBack: () => void;
  onOpenDaemon: () => void;
  onOpenHooks: () => void;
  profileSheet: ProfileSheetItem[] | null;
  onOpenProfile: () => void;
  onCloseProfile: () => void;
  onPickProfile: (name: string) => void;
}) {
  const profileSub = [vm.profileName, vm.profileModel, vm.profileThinking].filter(Boolean).join(' · ');
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
              {profileSub && <div style={SUB}>{profileSub}</div>}
            </div>
            <span
              role="button"
              onClick={onOpenProfile}
              style={{ font: `500 10px ${MONO}`, color: MC.run, flex: 'none', cursor: 'pointer' }}
            >
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
                    background: 'var(--proto-line-2)',
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
          <div style={rowStyle(true)}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={TITLE}>{copy.autoResume}</div>
              <div style={SUB}>{copy.autoResumeSub}</div>
            </div>
            <ReadOnlyToggle on={vm.autoResumeOn} label={copy.autoResume} />
          </div>
          <div style={rowStyle(true)}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={TITLE}>{copy.language}</div>
            </div>
            <LangToggle lang={lang} onSetLang={onSetLang} />
          </div>
          <div style={rowStyle(false)}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={TITLE}>{copy.theme}</div>
            </div>
            <ThemeToggle
              theme={theme}
              onSetTheme={onSetTheme}
              lightLabel={copy.themeLight}
              darkLabel={copy.themeDark}
            />
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
          <HooksDrillRow vm={vm} copy={copy} onOpenHooks={onOpenHooks} />
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
          <span style={{ marginLeft: 'auto' }}>build {BUILD_STAMP}</span>
        </div>
      </MScrollBody>
      {profileSheet && (
        <MBottomSheet onClose={onCloseProfile}>
          <div style={{ display: 'flex', alignItems: 'baseline', padding: '0 2px 10px' }}>
            <span style={{ fontSize: 17, fontWeight: 700, color: MC.ink, letterSpacing: '-.01em' }}>{copy.profileSheetTitle}</span>
          </div>
          <div style={{ background: 'var(--proto-card)', border: `1px solid ${MC.hairline}`, borderRadius: 13, overflow: 'hidden' }}>
            {profileSheet.map((it, i) => (
              <div
                key={it.name}
                onClick={() => onPickProfile(it.name)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 13px', borderBottom: i < profileSheet.length - 1 ? `1px solid var(--proto-line-soft)` : undefined, cursor: 'pointer' }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span style={{ font: `600 13px ${MONO}`, color: MC.ink }}>{it.name}</span>
                    {it.current && <span style={{ fontSize: 9.5, fontWeight: 600, padding: '1.5px 7px', borderRadius: 999, background: MC.runBg, color: MC.run }}>{copy.profileSheetCurrent}</span>}
                  </div>
                  <div style={{ font: `400 10px ${MONO}`, color: MC.muted, marginTop: 3 }}>{it.sub}</div>
                </div>
                {it.current && <span style={{ fontSize: 15, fontWeight: 700, color: MC.run, flex: 'none' }}>✓</span>}
              </div>
            ))}
          </div>
          <div style={{ font: `400 9.5px ${MONO}`, color: MC.faint, padding: '9px 4px 0' }}>{copy.profileSheetFooter}</div>
        </MBottomSheet>
      )}
    </>
  );
}
