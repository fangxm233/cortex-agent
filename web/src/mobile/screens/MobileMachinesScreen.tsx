// @ds-adherence-ignore -- mobile machines screen rebuilt with real `machines.list` data (raw px/hex/svg/
// font per §8.3 — the mobile palette is not in the light `proto.*` token set).
//
// Mobile machines screen (plan §12 A item 1, mobile part 12c). Wired to the REAL `machines.list`
// ui-service scope — joined view of machines.json (static config) + client-manager (live online state)
// + executionRegistry (running dispatch count). Schema: `MachineInfo` DTO only (守则11 §2.1).
//
// Each card shows: colored online-dot · name · OS badge · liveRuns badge (when > 0) · GPU row ·
// connected-since time. Honest placeholders (守则11 no-fabrication):
//   • cortexPath / sshConfigured / lastHeartbeat / capabilities — no card slot; omitted.
//   • connected-since — null when offline (stale DTO value is hidden; see mobile-machines-vm.ts).
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MachineInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useVocab, type Vocab } from '@/i18n';
import {
  buildMobileMachinesVm,
  fmtConnectedZh,
  type MachineCardVm,
} from './mobile-machines-vm';

const mono = "'IBM Plex Mono',monospace";

// ── online-status dot colors ─────────────────────────────────────────────────────────────────────

const DOT_ONLINE = '#23854F';
const DOT_OFFLINE = '#B6BDC9';

// ── pure presentational view (render-testable without tRPC / QueryClient providers) ─────────────

export interface MobileMachinesViewProps {
  cards: MachineCardVm[];
  vocab: Vocab;
  now: number;
}

export function MobileMachinesView({ cards, vocab, now }: MobileMachinesViewProps) {
  return (
    <div
      data-screen-label="machines"
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        paddingTop: 'env(safe-area-inset-top)',
        boxSizing: 'border-box',
        background: '#F2F2F7',
      }}
    >
      {/* header */}
      <div
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '6px 14px 10px',
          borderBottom: '1px solid #E7E9EE',
          background: '#F2F2F7',
        }}
      >
        <span
          style={{ fontSize: 22, fontWeight: 700, color: '#191C22', letterSpacing: '-.02em' }}
        >
          {vocab.machines}
        </span>
        {/* online / total count badge */}
        <span
          style={{
            marginLeft: 'auto',
            font: `600 10px ${mono}`,
            color: '#5B6472',
            background: '#EFF1F5',
            padding: '2px 9px',
            borderRadius: 999,
          }}
        >
          {cards.filter((c) => c.online).length} / {cards.length}
        </span>
      </div>

      {/* scrollable card list */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '12px 14px 0',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          background: '#F2F2F7',
        }}
      >
        {cards.length === 0 ? (
          <EmptyCard vocab={vocab} />
        ) : (
          cards.map((card) => <MachineCard key={card.name} card={card} vocab={vocab} now={now} />)
        )}
      </div>

      {/* home-indicator safe-area spacer */}
      <div style={{ flex: 'none', height: 28, background: '#F2F2F7' }} />
    </div>
  );
}

// ── single machine card ──────────────────────────────────────────────────────────────────────────

function MachineCard({ card, vocab, now }: { card: MachineCardVm; vocab: Vocab; now: number }) {
  const dotColor = card.online ? DOT_ONLINE : DOT_OFFLINE;
  const connectedLabel = card.online ? fmtConnectedZh(card.connectedAt, now) : null;

  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid #E7E9EE',
        borderRadius: 14,
        padding: '12px 14px',
      }}
    >
      {/* top row: dot · name · OS badge · liveRuns badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        {/* online status dot */}
        <span
          data-machine-dot={card.online ? 'online' : 'offline'}
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: dotColor,
            flex: 'none',
          }}
        />
        {/* machine name */}
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 14,
            fontWeight: 650,
            color: '#191C22',
            letterSpacing: '-.01em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {card.name}
        </span>
        {/* OS badge */}
        <span
          style={{
            font: `500 9.5px ${mono}`,
            color: '#8A93A2',
            background: '#F5F6F8',
            padding: '2px 7px',
            borderRadius: 6,
            flex: 'none',
          }}
        >
          {card.os}
        </span>
        {/* live runs badge — shown only when > 0 */}
        {card.liveRuns > 0 && (
          <span
            style={{
              font: `600 10px ${mono}`,
              color: '#fff',
              background: '#4655D4',
              padding: '2px 8px',
              borderRadius: 999,
              flex: 'none',
            }}
          >
            {card.liveRuns} {vocab.mLiveRuns}
          </span>
        )}
      </div>

      {/* sub-line: online / offline label · GPU count · connected-since */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginTop: 6,
          paddingLeft: 17,
          font: `400 10.5px ${mono}`,
          color: '#8A93A2',
        }}
      >
        <span style={{ color: card.online ? DOT_ONLINE : DOT_OFFLINE, fontWeight: 600 }}>
          {card.online ? vocab.mOnline : vocab.mOffline}
        </span>
        {/* GPU count — omit when null (no gpuCount entry in machines.json) */}
        {card.gpuCount !== null && (
          <span>
            {card.gpuCount} {vocab.mGpu}
          </span>
        )}
        {/* connected-since — shown only when online and a parseable connectedAt is available */}
        {connectedLabel && connectedLabel !== '—' && (
          <span style={{ marginLeft: 'auto' }}>{connectedLabel}</span>
        )}
      </div>
    </div>
  );
}

// ── empty state ──────────────────────────────────────────────────────────────────────────────────

function EmptyCard({ vocab }: { vocab: Vocab }) {
  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid #E7E9EE',
        borderRadius: 14,
        padding: '28px 14px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        textAlign: 'center',
      }}
    >
      <span style={{ fontSize: 13, color: '#B6BDC9' }}>{vocab.mNoMachines}</span>
    </div>
  );
}

// ── container: binds real tRPC machines.list ─────────────────────────────────────────────────────

export function MobileMachinesScreen() {
  const vocab = useVocab();
  const trpc = useTRPC();
  const now = Date.now();

  const machinesQuery = useQuery(trpc.machines.list.queryOptions({}));
  const machines = useMemo<MachineInfo[]>(() => machinesQuery.data ?? [], [machinesQuery.data]);
  const cards = useMemo(() => buildMobileMachinesVm(machines), [machines]);

  return <MobileMachinesView cards={cards} vocab={vocab} now={now} />;
}
