// Mobile approval screen (design 10e), rebuilt 1:1 from scheme.dc.html L3200-3247. A non-Tab page
// (‹ back header, no bottom Tab bar) reached from the 会话 context. Wired to the REAL `approvals.*`
// ui-service scope — the SAME data + tiered labels as desktop 7a (task 851f): `approvals.list` for the
// queue, `approvals.approve`/`approvals.reject` for a decision that flips the target entry's Status
// line in PENDING_APPROVALS.md (the mutate never runs the underlying op) → the list re-invalidates.
//
// Exact inline styles / px / hex / font / weight from the scheme (§8.3 raw-values-first; the mobile
// palette is not in the light `proto.*` token set). Real data substituted into the structure; ZH
// static chrome via i18n (useVocab). Honest placeholders — NO fabrication (851f precedent):
//   • 分级标签 pill        → real `operation` (no safety-class taxonomy field; omit when absent).
//   • 判定 box            → real `impact` (no approval-rule rationale field; omit when absent).
//   • 来源线程 row         → OMITTED (no thread / from / ttl field).
//   • queue metric        → OMITTED (`$6.40 / 剩余` etc. is prototype-only; the operation tier stays).
//   • id / age            → real `id` (a sha1 hash, ellipsis) / `queuedAt` date (no relative clock).
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { ApprovalInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useVocab, type Vocab } from '@/i18n';
import { buildMobileApprovalsVm, type MobileApprovalsVm } from './mobile-approvals-vm';

const mono = "'IBM Plex Mono',monospace";

// ── pure presentational view (render-testable without the tRPC / router providers) ─────────────

export interface MobileApprovalsViewProps {
  vm: MobileApprovalsVm;
  vocab: Vocab;
  armed: boolean;
  feedback: string;
  busy: boolean;
  onBack: () => void;
  onApprove: (id: string) => void;
  onArm: () => void;
  onCancel: () => void;
  onReject: (id: string) => void;
  onFeedback: (value: string) => void;
}

export function MobileApprovalsView(props: MobileApprovalsViewProps) {
  const { vm, vocab } = props;
  return (
    <div
      data-screen-label="10e"
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        paddingTop: 'env(safe-area-inset-top)',
        boxSizing: 'border-box',
        background: '#F2F2F7',
      }}
    >
      {/* header (scheme L3205-3210) */}
      <div
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '8px 14px 10px',
          borderBottom: '1px solid #E7E9EE',
          background: '#F2F2F7',
        }}
      >
        <span
          onClick={props.onBack}
          style={{ fontSize: 15, color: '#4655D4', flex: 'none', cursor: 'pointer' }}
        >
          ‹
        </span>
        <div style={{ fontSize: 16, fontWeight: 650, color: '#191C22', letterSpacing: '-.01em' }}>
          {vocab.approvals}
        </div>
        <span
          style={{
            font: `600 10px ${mono}`,
            color: '#8A5B06',
            background: '#F7ECCE',
            padding: '2px 8px',
            borderRadius: 999,
          }}
        >
          {vm.pendingCount} {vocab.toProcess}
        </span>
        <span style={{ marginLeft: 'auto', font: `400 9.5px ${mono}`, color: '#B6BDC9' }}>
          PENDING_APPROVALS.md
        </span>
      </div>

      {/* body (scheme L3211) */}
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
        {vm.firstCard ? <FirstCard {...props} /> : <AllClearCard vocab={vocab} />}

        {vm.queueRows.map((row) => (
          <QueueRow key={row.id} row={row} />
        ))}

        {vm.processedRows.length > 0 && (
          <>
            {/* 本周已处理 divider (scheme L3237) */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '2px 2px' }}>
              <div style={{ flex: 1, height: 1, background: '#E3E5EA' }} />
              <div
                style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '.06em', color: '#B6BDC9' }}
              >
                {vocab.weekProcessed}
              </div>
              <div style={{ flex: 1, height: 1, background: '#E3E5EA' }} />
            </div>
            {vm.processedRows.map((row, i) => (
              <ProcessedRow key={row.id} row={row} first={i === 0} />
            ))}
          </>
        )}

        {/* Slack sync footer (scheme L3242) */}
        <div
          style={{
            marginTop: 'auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 7,
            padding: '10px 0 12px',
          }}
        >
          <span style={{ fontSize: 10.5, color: '#B6BDC9' }}>{vocab.slackSynced}</span>
          <FootChip>/approval</FootChip>
          <FootChip>approve 1</FootChip>
        </div>
      </div>

      {/* home-indicator gutter (scheme L3244) — non-Tab page owns its own bottom OS inset */}
      <div style={{ flex: 'none', height: 'calc(8px + env(safe-area-inset-bottom))', background: '#F2F2F7' }} />
    </div>
  );
}

// ── first (expanded) pending card — decision happens inline (scheme L3213-3225) ─────────────────

function FirstCard(props: MobileApprovalsViewProps) {
  const { vm, vocab, armed, feedback, busy } = props;
  const card = vm.firstCard!;
  return (
    <div
      style={{
        border: '1px solid #EFDDB0',
        background: '#fff',
        borderRadius: 14,
        overflow: 'hidden',
        boxShadow: '0 1px 3px rgba(16,24,40,.05)',
      }}
    >
      <div style={{ padding: '12px 14px 0' }}>
        {/* meta row: tier pill + real id (ellipsis) + queuedAt age */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          {card.tier && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: 999,
                background: card.tier.bg,
                color: card.tier.fg,
                flex: 'none',
              }}
            >
              {card.tier.text}
            </span>
          )}
          <span
            style={{
              font: `400 10px ${mono}`,
              color: '#C0A96E',
              flex: 1,
              minWidth: 0,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {card.id}
          </span>
          {card.age && (
            <span style={{ font: `400 10px ${mono}`, color: '#B6BDC9', flex: 'none' }}>
              {card.age}
            </span>
          )}
        </div>
        <div
          style={{ fontSize: 14.5, fontWeight: 600, color: '#191C22', lineHeight: 1.4, marginTop: 8 }}
        >
          {card.title}
        </div>
        {card.reason && (
          <div style={{ fontSize: 12, lineHeight: 1.55, color: '#5B6472', marginTop: 4 }}>
            {card.reason}
          </div>
        )}
        {/* 判定 box — real IMPACT (scheme's approval-rule rationale has no backing field) */}
        {card.judgement && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginTop: 8,
              padding: '7px 10px',
              background: '#FDF9F0',
              border: '1px solid #F7ECCE',
              borderRadius: 9,
            }}
          >
            <span
              style={{ width: 5, height: 5, borderRadius: '50%', background: '#C99A2E', flex: 'none' }}
            />
            <span style={{ fontSize: 10.5, color: '#6B5A1E' }}>{card.judgement}</span>
          </div>
        )}
        {/* 来源线程 row OMITTED — no thread / from / ttl field (851f gap) */}
      </div>

      {/* decision buttons (scheme L3221-3224); armed → feedback input + confirm/cancel (851f) */}
      {!armed ? (
        <div style={{ display: 'flex', gap: 8, padding: '12px 14px 14px' }}>
          <button
            type="button"
            disabled={busy}
            onClick={() => props.onApprove(card.id)}
            style={{
              flex: 1,
              height: 44,
              borderRadius: 11,
              background: '#191C22',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 14,
              fontWeight: 600,
              border: 'none',
              cursor: busy ? 'not-allowed' : 'pointer',
              opacity: busy ? 0.6 : 1,
              fontFamily: 'inherit',
            }}
          >
            {vocab.approve}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={props.onArm}
            style={{
              flex: 1,
              height: 44,
              borderRadius: 11,
              border: '1.5px solid #D9DCE3',
              background: '#fff',
              color: '#191C22',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 14,
              fontWeight: 600,
              boxSizing: 'border-box',
              cursor: busy ? 'not-allowed' : 'pointer',
              opacity: busy ? 0.6 : 1,
              fontFamily: 'inherit',
            }}
          >
            {vocab.rejectFeedback}
          </button>
        </div>
      ) : (
        <div style={{ padding: '12px 14px 14px' }}>
          <input
            data-approval-feedback=""
            value={feedback}
            onChange={(e) => props.onFeedback(e.target.value)}
            placeholder={vocab.rejectFeedback}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              border: '1px solid #EED3D0',
              background: '#fff',
              borderRadius: 11,
              padding: '11px 12px',
              fontSize: 13,
              color: '#191C22',
              fontFamily: 'inherit',
            }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              type="button"
              disabled={busy}
              onClick={props.onCancel}
              style={{
                flex: 1,
                height: 44,
                borderRadius: 11,
                border: '1.5px solid #D9DCE3',
                background: '#fff',
                color: '#191C22',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 14,
                fontWeight: 600,
                boxSizing: 'border-box',
                cursor: busy ? 'not-allowed' : 'pointer',
                opacity: busy ? 0.6 : 1,
                fontFamily: 'inherit',
              }}
            >
              {vocab.cancel}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => props.onReject(card.id)}
              style={{
                flex: 1,
                height: 44,
                borderRadius: 11,
                background: '#C03D33',
                color: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 14,
                fontWeight: 600,
                border: 'none',
                cursor: busy ? 'not-allowed' : 'pointer',
                opacity: busy ? 0.6 : 1,
                fontFamily: 'inherit',
              }}
            >
              {vocab.denyConfirm}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── collapsed queue row (scheme L3227-3235) ─────────────────────────────────────────────────────

function QueueRow({ row }: { row: MobileApprovalsVm['queueRows'][number] }) {
  return (
    <div
      style={{
        border: '1px solid #E7E9EE',
        background: '#fff',
        borderRadius: 14,
        padding: '11px 14px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span
          style={{ width: 6, height: 6, borderRadius: '50%', background: '#C99A2E', flex: 'none' }}
        />
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: '#22262E',
            flex: 1,
            minWidth: 0,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {row.title}
        </span>
        {row.age && (
          <span style={{ font: `400 10px ${mono}`, color: '#B6BDC9', flex: 'none' }}>{row.age}</span>
        )}
      </div>
      {row.tier && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, paddingLeft: 13 }}>
          <span
            style={{
              fontSize: 9.5,
              fontWeight: 600,
              padding: '1.5px 7px',
              borderRadius: 999,
              background: row.tier.bg,
              color: row.tier.fg,
            }}
          >
            {row.tier.text}
          </span>
          {/* per-type metric ($6.40 / 剩余 · refs=0) OMITTED — prototype-only, no backing field */}
        </div>
      )}
    </div>
  );
}

// ── processed (this-week) row (scheme L3239-3240) ───────────────────────────────────────────────

function ProcessedRow({
  row,
  first,
}: {
  row: MobileApprovalsVm['processedRows'][number];
  first: boolean;
}) {
  return (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: 9, padding: first ? '2px 4px' : '0 4px' }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: row.approved ? '#23854F' : '#C03D33',
          flex: 'none',
        }}
      >
        {row.approved ? '✓' : '✕'}
      </span>
      <span
        style={{
          fontSize: 12,
          color: '#5B6472',
          flex: 1,
          minWidth: 0,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {row.title}
      </span>
      {row.date && (
        <span style={{ font: `400 9.5px ${mono}`, color: '#B6BDC9', flex: 'none' }}>{row.date}</span>
      )}
    </div>
  );
}

function FootChip({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        font: `500 10px ${mono}`,
        color: '#8A93A2',
        background: '#fff',
        border: '1px solid #E7E9EE',
        padding: '2px 8px',
        borderRadius: 6,
      }}
    >
      {children}
    </span>
  );
}

// All-clear card shown when nothing is pending (scheme draws no mobile empty state; reuse 851f copy).
function AllClearCard({ vocab }: { vocab: Vocab }) {
  return (
    <div
      style={{
        border: '1px solid #E7E9EE',
        background: '#fff',
        borderRadius: 14,
        padding: '22px 14px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        textAlign: 'center',
      }}
    >
      <span
        style={{
          width: 34,
          height: 34,
          borderRadius: '50%',
          background: '#E9F4EE',
          color: '#23854F',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 15,
          fontWeight: 700,
        }}
      >
        ✓
      </span>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#191C22' }}>{vocab.aprEmptyTitle}</div>
      <div style={{ fontSize: 11, color: '#8A93A2' }}>{vocab.aprEmptyDesc}</div>
    </div>
  );
}

// ── container: binds real tRPC data + mutations ─────────────────────────────────────────────────

export function MobileApprovalsScreen() {
  const vocab = useVocab();
  const navigate = useNavigate();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // No status filter → all entries (pending drive the queue; resolved feed 本周已处理).
  const listQuery = useQuery(trpc.approvals.list.queryOptions({}));
  const entries = useMemo<ApprovalInfo[]>(() => listQuery.data ?? [], [listQuery.data]);
  const vm = useMemo(() => buildMobileApprovalsVm(entries), [entries]);

  const [armed, setArmed] = useState(false);
  const [feedback, setFeedback] = useState('');
  const reset = () => {
    setArmed(false);
    setFeedback('');
  };
  const invalidate = () => queryClient.invalidateQueries(trpc.approvals.list.queryFilter());

  const approve = useMutation(
    trpc.approvals.approve.mutationOptions({
      onSettled: () => {
        reset();
        invalidate();
      },
    }),
  );
  const reject = useMutation(
    trpc.approvals.reject.mutationOptions({
      onSettled: () => {
        reset();
        invalidate();
      },
    }),
  );
  const busy = approve.isPending || reject.isPending;

  return (
    <MobileApprovalsView
      vm={vm}
      vocab={vocab}
      armed={armed}
      feedback={feedback}
      busy={busy}
      onBack={() => navigate('/m/sessions')}
      onApprove={(id) => approve.mutate({ id })}
      onArm={() => setArmed(true)}
      onCancel={reset}
      onReject={(id) => reject.mutate({ id, feedback: feedback.trim() || undefined })}
      onFeedback={setFeedback}
    />
  );
}
