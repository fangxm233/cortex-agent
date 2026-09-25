// /base — prototype 1:1 base specimen (design §8.6 RA / task 6d21).
// Pure presentational surface that exercises the faithful base — the exact fonts
// (system sans for UI, IBM Plex Mono for data/IDs), the audited prototype palette,
// and the prototype animation set — so a rendered screenshot can be diffed against
// the prototype (design/ref/prototype.dc.html + proto-shots/00-workbench.png).
// Uses raw exact prototype hex/px in the specimens (per §8.3 the design values are
// authoritative); the point is to confirm the base renders identically.

interface Swatch {
  name: string;
  hex: string;
  dark?: boolean;
}

// The audited recurring prototype palette (mirrors tailwind `proto.*`).
const SWATCHES: Swatch[] = [
  { name: 'base', hex: 'var(--surface-base)' },
  { name: 'card', hex: 'var(--proto-card)' },
  { name: 'rail', hex: 'var(--proto-rail)' },
  { name: 'alt', hex: 'var(--proto-alt)' },
  { name: 'gray', hex: 'var(--proto-gray)' },
  { name: 'ink', hex: 'var(--proto-ink)', dark: true },
  { name: 'ink-2', hex: 'var(--proto-ink-2)', dark: true },
  { name: 'ink-3', hex: 'var(--proto-ink-3)', dark: true },
  { name: 'muted', hex: 'var(--proto-muted)', dark: true },
  { name: 'muted-2', hex: 'var(--proto-muted-2)', dark: true },
  { name: 'muted-3', hex: 'var(--proto-muted-3)', dark: true },
  { name: 'faint', hex: 'var(--proto-faint)' },
  { name: 'line', hex: 'var(--proto-line)' },
  { name: 'line-2', hex: 'var(--proto-line-2)' },
  { name: 'line-3', hex: 'var(--proto-line-3)' },
  { name: 'line-4', hex: 'var(--proto-line-4)' },
  { name: 'accent', hex: 'var(--proto-accent)', dark: true },
  { name: 'accent-bg', hex: 'var(--proto-accent-bg)' },
  { name: 'accent-border', hex: 'var(--proto-accent-border)' },
  { name: 'accent-2', hex: 'var(--proto-accent-2)', dark: true },
  { name: 'accent-strong', hex: 'var(--proto-accent-strong)', dark: true },
  { name: 'amber', hex: 'var(--proto-amber)', dark: true },
  { name: 'amber-fg', hex: 'var(--proto-amber-fg)', dark: true },
  { name: 'amber-bg', hex: 'var(--proto-amber-bg)' },
  { name: 'amber-border', hex: 'var(--proto-amber-border)' },
  { name: 'amber-accent', hex: 'var(--proto-amber-accent)', dark: true },
  { name: 'success', hex: 'var(--proto-success)', dark: true },
  { name: 'success-bg', hex: 'var(--proto-success-bg)' },
  { name: 'danger', hex: 'var(--proto-danger)', dark: true },
  { name: 'danger-bg', hex: 'var(--proto-danger-bg)' },
];

// The 16 prototype keyframes, shown as live specimens.
const ANIMATIONS: string[] = [
  'cxblink',
  'cxpulse',
  'cxtoast',
  'cxfade',
  'cxmodal',
  'cxcmdk',
  'cxpop',
  'cxpopup',
  'cxpopover',
  'cxdrawer',
  'cxmodalout',
  'cxcmdkout',
  'cxdrawerout',
  'cxfadeout',
  'cxmsg',
  'cxrise',
];

const MONO_SIZES = ['9px', '10px', '10.5px', '11px', '12px', '15px'];

function SectionTitle({ children }: { children: string }) {
  return (
    <div
      style={{
        fontSize: '10px',
        fontWeight: 700,
        letterSpacing: '0.07em',
        color: 'var(--proto-faint)',
        textTransform: 'uppercase',
        margin: '28px 0 12px',
      }}
    >
      {children}
    </div>
  );
}

export function BaseDemoPage() {
  return (
    <div style={{ padding: '24px 28px', background: 'var(--proto-card)', minHeight: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
        <div
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            background: 'var(--proto-ink)',
            color: 'var(--ink-solid-fg)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            font: "600 12px 'IBM Plex Mono',monospace",
          }}
        >
          cx
        </div>
        <div style={{ fontWeight: 650, fontSize: 14, color: 'var(--proto-ink)', letterSpacing: '-0.01em' }}>
          Cortex — base specimen
        </div>
      </div>

      {/* ── Typography ── */}
      <SectionTitle>Sans (UI)</SectionTitle>
      <div style={{ fontFamily: 'inherit', color: 'var(--proto-ink)' }}>
        <div style={{ fontSize: 14, fontWeight: 650, letterSpacing: '-0.01em' }}>
          Interface heading — 14px / 650
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>Section label — 13px / 600</div>
        <div style={{ fontSize: 12.5, fontWeight: 400, color: 'var(--proto-muted)', marginTop: 4 }}>
          Body copy — 12.5px / 400 · The quick brown fox jumps over the lazy dog. 中文界面文字样张。
        </div>
      </div>

      <SectionTitle>Mono (data / IDs) — IBM Plex Mono</SectionTitle>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {MONO_SIZES.map((sz) => (
          <div
            key={sz}
            style={{ font: `500 ${sz} 'IBM Plex Mono',monospace`, color: 'var(--proto-ink)' }}
          >
            thr_502fb888 · 6d21 · $2.64 · 3m 27s — {sz}
          </div>
        ))}
      </div>

      {/* ── Palette ── */}
      <SectionTitle>Palette (audited prototype colors)</SectionTitle>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
          gap: 8,
        }}
      >
        {SWATCHES.map((s) => (
          <div
            key={s.name}
            style={{
              border: '1px solid var(--proto-line)',
              borderRadius: 8,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: 40,
                background: s.hex,
                display: 'flex',
                alignItems: 'flex-end',
                justifyContent: 'flex-end',
                padding: 5,
              }}
            >
              <span
                style={{
                  font: "500 8.5px 'IBM Plex Mono',monospace",
                  color: s.dark ? 'var(--proto-card)' : 'var(--proto-muted-3)',
                }}
              >
                {s.hex}
              </span>
            </div>
            <div
              style={{
                padding: '5px 7px',
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--proto-ink-2)',
                background: 'var(--proto-card)',
              }}
            >
              {s.name}
            </div>
          </div>
        ))}
      </div>

      {/* ── Live animation specimens ── */}
      <SectionTitle>Animations — running dot · caret · enter set</SectionTitle>
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: 'var(--proto-accent)',
              display: 'inline-block',
              animation: 'cxpulse 1.6s ease-in-out infinite',
            }}
          />
          <span style={{ fontSize: 12, color: 'var(--proto-accent)', fontWeight: 600 }}>running (cxpulse)</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: 'var(--proto-amber)',
              display: 'inline-block',
              animation: 'cxpulse 2s ease-in-out infinite',
            }}
          />
          <span style={{ fontSize: 12, color: 'var(--proto-amber-fg)', fontWeight: 600 }}>approval (cxpulse 2s)</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
          <span style={{ font: "500 12px 'IBM Plex Mono',monospace", color: 'var(--proto-ink)' }}>cortex</span>
          <span
            style={{
              display: 'inline-block',
              width: 7,
              height: 14,
              background: 'var(--proto-ink)',
              animation: 'cxblink 1.1s steps(1) infinite',
            }}
          />
          <span style={{ fontSize: 12, color: 'var(--proto-muted-3)', marginLeft: 6 }}>caret (cxblink)</span>
        </div>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))',
          gap: 8,
        }}
      >
        {ANIMATIONS.map((a) => (
          <div
            key={a}
            style={{
              border: '1px solid var(--proto-line)',
              borderRadius: 8,
              padding: '10px 8px',
              textAlign: 'center',
              background: 'var(--proto-rail)',
              // Loop the enter/exit specimens so the reviewer can see each fire.
              animation: `${a} 1.6s ease-in-out infinite`,
            }}
          >
            <span style={{ font: "500 10px 'IBM Plex Mono',monospace", color: 'var(--proto-ink-2)' }}>{a}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
