// input:  mobile session queries, UI shortcuts and chat mutations
// output: MChatScreen live chat with local slash actions
// pos:    Mobile session detail state and data orchestration
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { useMobileProject } from '@/mobile/current-project';
import {
  resolveTurns,
  currentTurnElapsedMs,
  formatElapsed,
  rewindStats,
} from '@/features/workbench/transcript-vm';
import { scheduledRunTitle } from '@/features/workbench/schedule-rail';
import { useSessionMessageLiveSync } from '@/features/workbench/useSessionMessageLiveSync';
import { useOptimisticUserMessages } from '@/features/workbench/useOptimisticUserMessages';
import { runOptimisticMutation } from '@/features/workbench/optimistic-message';
import { useInteractionActions } from '@/features/workbench/useInteractionActions';
import { useMarkSessionRead } from '@/features/workbench/useMarkSessionRead';
import { useSessionCompact } from '@/features/workbench/useSessionCompact';
import { buildProfileOptions, currentBackendOf } from '@/features/workbench/profile-menu';
import {
  buildSlashSuggestions, resolveSlashInput, runSlashAction,
  type SlashAction, type SlashActionHandlers, type SlashSuggestion,
} from '@/features/workbench/composer-slash';
import {
  resolveTransitionProfile,
  type PendingCreatedSession,
} from '@/features/workbench/selected-session';
import { useThreadGetLiveSync } from '@/features/thread/useThreadGetLiveSync';
import { threadPill } from '@/features/workbench/thread-card-proto';
import { buildMobileStepper } from '@/mobile/screens/mobile-session-vm';
import { MobileThreadStepper } from '@/mobile/screens/MobileThreadStepper';
import type { AttachmentMeta } from '@/features/workbench/chat-content';
import { fetchFileObjectUrl } from '@/lib/files';
import {
  draftStorageKey,
  loadDraft,
  saveDraft,
  clearDraft,
  mergeRestoredDraft,
  type ComposerDraft,
} from '@/features/workbench/composer-draft';
import { apiBase, authHeaders } from '@/lib/desktop-config';
import {
  askCardModel,
  planCardModel,
  emptyAskAnswers,
  currentQuestionIndex,
  commitAnswer,
  toggleSelected,
  confirmSelected,
  askComplete,
  mergedAnswers,
  type AskAnswerState,
  type AskCardModel,
  type PlanCardModel,
} from '@/features/workbench/interaction-vm';
import { MChatView, type MChatCopy, type MChatInteractions, type MRejectBar, type MChatEditCopy, type MMsgMenu, type MEditMode } from './MChatView';
import { M_INT_COPY } from './MInteractionCards';
import type { RejectPlanNavState } from './MPlanReadScreen';
import {
  buildMobileChatRows,
  chatHeaderStatus,
  interactionHeaderStatus,
  effectiveProfileName,
  profileChipLabel,
  buildProfileSheetItems,
  type PendingAttachmentVM,
} from './m-chat-vm';

const EMPTY_TRANSCRIPT = { sessionId: '', turns: [] };
const UPLOAD_PATH = '/api/attachments/upload';

const COPY: { en: MChatCopy; zh: MChatCopy } = {
  zh: {
    composerPh: '输入消息，/ 调用命令',
    toolCallsUnit: '次工具调用',
    menuRename: '重命名',
    menuExport: '导出',
    menuArchive: '归档',
    menuSessionId: '会话 ID',
    sessionIdTitle: '会话 ID',
    cortexIdLabel: 'Cortex ID',
    backendUuidLabel: '后端 UUID',
    copy: '复制',
    copied: '已复制',
    attachCamera: '拍照',
    attachLibrary: '照片图库',
    attachFile: '选择文件',

    attachPlaceholder: '补充说明…',
    profileTitle: 'Profile',
    profileSubtitle: '仅本会话 · 热更新',
    profileCurrent: '当前',
    profileFooter: '切换仅影响本会话后续 turn · 运行中线程不受影响 · 全局默认在设置',
    lineUnit: '行',
    charUnit: '字',
  },
  en: {
    composerPh: 'Message, / for commands',
    toolCallsUnit: 'tool calls',
    menuRename: 'Rename',
    menuExport: 'Export',
    menuArchive: 'Archive',
    menuSessionId: 'Session ID',
    sessionIdTitle: 'Session ID',
    cortexIdLabel: 'Cortex ID',
    backendUuidLabel: 'Backend UUID',
    copy: 'Copy',
    copied: 'Copied',
    attachCamera: 'Take photo',
    attachLibrary: 'Photo library',
    attachFile: 'Choose file',

    attachPlaceholder: 'Add a note…',
    profileTitle: 'Profile',
    profileSubtitle: 'This session · hot-swap',
    profileCurrent: 'current',
    profileFooter: 'Applies to this session’s next turns only · running threads unaffected · global default in Settings',
    lineUnit: 'lines',
    charUnit: 'chars',
  },
};

// sec-7 message edit + rewind copy (7a long-press menu · 7b edit mode · 已编辑/原消息 · regen note).
const EDIT_COPY: { en: MChatEditCopy; zh: MChatEditCopy } = {
  zh: {
    menuCopy: '复制',
    menuEdit: '编辑消息',
    editingBadge: '编辑中',
    willRewind: (replies, toolCalls) => `将被回退 · ${replies} 条回复 · ${toolCalls} 次工具调用`,
    editBarTitle: '编辑消息 — 发送将回退后续回复',
    edited: '已编辑',
    original: '原消息',
    regenNote: '由编辑重新生成',
  },
  en: {
    menuCopy: 'Copy',
    menuEdit: 'Edit message',
    editingBadge: 'Editing',
    willRewind: (replies, toolCalls) => `Will rewind · ${replies} repl${replies === 1 ? 'y' : 'ies'} · ${toolCalls} tool call${toolCalls === 1 ? '' : 's'}`,
    editBarTitle: 'Editing message — send rewinds later replies',
    edited: 'edited',
    original: 'Original message',
    regenNote: 'Regenerated from edit',
  },
};

// Inline experiment-pipeline thread card (scheme 1b L148-158), bound to REAL threads.get. Scoped to
// THIS conversation: threads.list({sessionId}) resolves the session's channel server-side and returns
// only the thread(s) running on it, so the card shows the thread this chat spawned — never a random
// global one. Empty when the session owns no active thread (the query returns []). `打开 →` drills to 1g.
function InlineThreadCard({ sessionId, subthreadsLabel, openLabel }: { sessionId: string; subthreadsLabel: string; openLabel: string }): JSX.Element | null {
  const navigate = useNavigate();
  const trpc = useTRPC();
  const listQuery = useQuery({
    ...trpc.threads.list.queryOptions({ status: ['running', 'waiting'], sessionId }),
    enabled: !!sessionId,
  });
  const threads = listQuery.data ?? [];
  const target = threads.find((t) => t.status === 'running') ?? threads[0] ?? null;
  const threadId = target?.id ?? '';
  useThreadGetLiveSync(threadId);
  const getQuery = useQuery({ ...trpc.threads.get.queryOptions({ threadId }), enabled: !!threadId });
  if (!threadId || getQuery.isPending || getQuery.isError || !getQuery.data) return null;
  const detail = getQuery.data;
  return (
    <MobileThreadStepper
      card={buildMobileStepper(detail)}
      pill={threadPill(detail.status)}
      subthreadsLabel={subthreadsLabel}
      openLabel={openLabel}
      onOpen={() => navigate(`/m/thread/${threadId}`)}
    />
  );
}

interface PendingUpload {
  id: string;
  /** Absent for attachments restored from a persisted draft (already on the server via `meta.path`). */
  file?: File;
  status: 'uploading' | 'done' | 'error';
  progress: number;
  meta?: AttachmentMeta;
  /** 'image' | 'video' | 'file' for the composer chip preview. */
  type: 'image' | 'video' | 'file';
  /** Local object URL for image/video previews (revoked on remove / send). */
  previewUrl?: string;
}

function classifyFileType(file: File): 'image' | 'video' | 'file' {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  return 'file';
}

let _uid = 0;
const nextId = (): string => `att_${++_uid}_${Date.now()}`;

// Raw XHR upload (ported from the desktop Composer — module-private there). Plain HTTP + File API,
// works on mobile browsers. Returns the AttachmentMeta the send path references.
function uploadFile(file: File, sessionId: string, onProgress: (pct: number) => void): Promise<AttachmentMeta> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    // Absolute server URL in native-shell/remote mode; relative (same-origin) in browser mode.
    xhr.open('POST', `${apiBase()}${UPLOAD_PATH}`);
    xhr.setRequestHeader('X-Session-Id', sessionId);
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    // Native-shell auth token (no-op in browser/ui-http mode — proxy/Access supplies it).
    Object.entries(authHeaders()).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.responseType = 'json';
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    });
    xhr.addEventListener('load', () => {
      const body = xhr.response as { ok?: boolean; data?: AttachmentMeta; message?: string } | null;
      if (xhr.status >= 200 && xhr.status < 300 && body?.ok && body.data) resolve(body.data);
      else reject(new Error(body?.message || `Upload failed (${xhr.status})`));
    });
    xhr.addEventListener('error', () => reject(new Error('Network error')));
    xhr.send(file);
  });
}

export function MChatScreen(): JSX.Element {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const lang = useLang();
  const copy = pickCopy(lang, COPY);
  const { currentProjectId } = useMobileProject();
  const { sessionId: routeParam } = useParams<{ sessionId: string }>();
  const isDraft = routeParam === 'new';

  const sessionsQuery = useQuery(
    trpc.sessions.list.queryOptions({ origin: 'direct', projectId: currentProjectId ?? undefined }),
  );
  // Scheduled runs open on the same page (scheme-mobile 8d) — the Scheduled sheet navigates here,
  // so the active-session membership must include them.
  const scheduledSessionsQuery = useQuery(
    trpc.sessions.list.queryOptions({ origin: 'scheduled', projectId: currentProjectId ?? undefined }),
  );
  const active = useMemo(() => {
    const list = [...(sessionsQuery.data ?? []), ...(scheduledSessionsQuery.data ?? [])];
    return list.find((s) => s.sessionId === routeParam) ?? null;
  }, [sessionsQuery.data, scheduledSessionsQuery.data, routeParam]);
  const sessionId = isDraft ? '' : (active?.sessionId ?? routeParam ?? '');
  // Un-adopted scheduled run (8d): title「schedule 名 · run #n」+ reply-adopts hint; replying
  // converts it to a normal session server-side (nothing special to send).
  const isScheduledRun = active?.origin === 'scheduled';
  const schedulesQuery = useQuery({
    ...trpc.schedules.list.queryOptions({ projectId: currentProjectId ?? undefined }),
    enabled: !!active?.scheduleId,
  });
  const runTitle = useMemo(() => {
    if (!isScheduledRun || !active?.scheduleId) return null;
    const sched = (schedulesQuery.data ?? []).find((s) => s.id === active.scheduleId) ?? null;
    const runs = (scheduledSessionsQuery.data ?? []).filter((s) => s.scheduleId === active.scheduleId);
    return scheduledRunTitle(sched, runs, active.sessionId);
  }, [isScheduledRun, active?.scheduleId, active?.sessionId, schedulesQuery.data, scheduledSessionsQuery.data]);

  const transcriptQuery = useQuery({
    ...trpc.sessions.transcript.queryOptions({ sessionId }),
    enabled: !!sessionId,
  });
  // `deltas: true` — this is the surface that shows a live preview, so it (and only it) opens the
  // session-scoped delta subscription; the reply then grows token by token instead of landing whole
  // seconds later. The opt-in costs one SSE connection, so no other consumer of this hook asks for
  // it — notably the plan reading page (MPlanReadScreen), which renders no chat. `transcript` is
  // passed back in only so a pending row self-heals if its delivered event is lost to a dropped frame.
  const { liveTail, getMessageSnapshot, streaming, running, liveTurns, contextUsage, streamingText, pendingUser } =
    useSessionMessageLiveSync(sessionId, active?.running, active?.backgroundRunning, {
      deltas: true,
      transcript: transcriptQuery.data ?? null,
      contextUsage: active?.contextUsage ?? null,
    });
  // A sent message shows in the stream on the frame it is sent (same reconciliation the desktop
  // chat uses), instead of vanishing until the server echoes it back.
  const optimistic = useOptimisticUserMessages({
    sessionId,
    isDraft,
    projectId: currentProjectId ?? 'general',
    transcript: transcriptQuery.data ?? null,
    liveTail,
    pendingUser,
    getMessageSnapshot,
  });
  const compactAction = useSessionCompact(sessionId, {
    running,
    hasBackendHistory: !!active?.backendSessionId,
  });
  // Interaction cards are transcript rows (web-interactions-redesign); this hook only supplies
  // the answer/approve/reject actions.
  const interactionActions = useInteractionActions(sessionId);
  // Unread write side (mirrors desktop CenterChat): viewing a session stamps it read (debounced,
  // visibility-gated), re-arming on live activity so a reply landing under the user's eyes never
  // stays unread. onSuccess invalidates sessions.list → clears the marker + project switcher badge.
  useMarkSessionRead(sessionId, `${liveTail.length}:${running}`);
  const transcript = transcriptQuery.data ?? EMPTY_TRANSCRIPT;
  const rows = useMemo(
    () => buildMobileChatRows(transcript, liveTail, {
      streaming, streamingText, pendingUser: optimistic.pendingUser,
      stripScheduledPrefix: !!active?.scheduleId || isScheduledRun,
    }),
    [transcript, liveTail, streaming, streamingText, optimistic.pendingUser, active?.scheduleId, isScheduledRun],
  );
  const turns = resolveTurns(liveTurns, active?.numTurns ?? null);
  const elapsed = useMemo(() => formatElapsed(currentTurnElapsedMs(transcriptQuery.data)), [transcriptQuery.data]);

  // ── pending interaction (scheme 4/5/6: cards + header override + composer routing) ──
  const pendingInteraction = useMemo(() => {
    for (const r of rows) {
      if (r.kind === 'interaction' && r.detail?.status === 'pending') return { detail: r.detail, ts: r.ts ?? null };
    }
    return null;
  }, [rows]);
  const pendingAskModel = pendingInteraction?.detail.kind === 'ask-user'
    ? askCardModel(pendingInteraction.detail, pendingInteraction.ts)
    : null;
  const pendingPlanModel = pendingInteraction?.detail.kind === 'plan-approval'
    ? planCardModel(pendingInteraction.detail, pendingInteraction.ts)
    : null;

  // Session-local progressive answers per ask card (5b: 答一题进一题, the entity resolves once
  // when the LAST question is answered).
  const [askStates, setAskStates] = useState<Record<string, AskAnswerState>>({});
  const askStateOf = (id: string): AskAnswerState => askStates[id] ?? emptyAskAnswers;
  const commitAndMaybeSubmit = (model: AskCardModel, next: AskAnswerState): void => {
    setAskStates((prev) => ({ ...prev, [model.requestId]: next }));
    if (askComplete(model, next)) interactionActions.answerQuestion(model.requestId, mergedAnswers(model, next));
  };
  const onAskPick = (model: AskCardModel, label: string): void => {
    const st = askStateOf(model.requestId);
    const q = model.questions[currentQuestionIndex(model, st)];
    if (q) commitAndMaybeSubmit(model, commitAnswer(st, q.question, label));
  };
  const onAskToggle = (model: AskCardModel, label: string): void => {
    setAskStates((prev) => ({ ...prev, [model.requestId]: toggleSelected(askStateOf(model.requestId), label) }));
  };
  const onAskConfirmMulti = (model: AskCardModel): void => {
    const st = askStateOf(model.requestId);
    const q = model.questions[currentQuestionIndex(model, st)];
    if (q && st.selected.length > 0) commitAndMaybeSubmit(model, confirmSelected(st, q.question));
  };

  // 5a reject mode — armed by the card's 驳回并反馈 or by the reading page's router state.
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const location = useLocation();
  useEffect(() => {
    const st = location.state as RejectPlanNavState | null;
    if (st?.rejectPlan) {
      setRejectingId(st.rejectPlan);
      navigate(location.pathname, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);
  // Auto-disarm when the plan resolves elsewhere (Slack / desktop / timeout).
  const pendingPlanId = pendingPlanModel?.requestId ?? null;
  useEffect(() => {
    if (rejectingId && rejectingId !== pendingPlanId) setRejectingId(null);
  }, [rejectingId, pendingPlanId]);

  const onOpenRead = (m: PlanCardModel): void => navigate(`/m/session/${sessionId}/plan/${m.requestId}`);

  // ── profiles (1p) ──
  const configQuery = useQuery(trpc.config.get.queryOptions({}));
  const profiles = configQuery.data?.profiles?.profiles ?? [];
  const defaultProfile = configQuery.data?.profiles?.defaultProfile ?? null;
  const [draftProfile, setDraftProfile] = useState<string | null>(null);
  const [pendingCreatedSession, setPendingCreatedSession] = useState<PendingCreatedSession | null>(null);
  const transitionProfile = resolveTransitionProfile(
    active?.profileName,
    pendingCreatedSession,
    sessionId,
  );
  const effectiveProfile = effectiveProfileName(
    isDraft ? draftProfile : transitionProfile,
    profiles,
    defaultProfile,
  );

  useEffect(() => {
    if (!pendingCreatedSession) return;
    const authoritativeArrived = active?.sessionId === pendingCreatedSession.sessionId;
    const movedElsewhere = !isDraft && sessionId !== pendingCreatedSession.sessionId;
    if (authoritativeArrived || movedElsewhere) setPendingCreatedSession(null);
  }, [active?.sessionId, isDraft, pendingCreatedSession, sessionId]);

  // ── mutations ──
  const sendMut = useMutation(trpc.sessions.send.mutationOptions());
  // The created session is adopted in the send's onAccepted, not here: promoting the optimistic row
  // onto the new session id and navigating to it must land in one render, or the row blinks out
  // while the draft scope is already gone.
  const createAndSendMut = useMutation(trpc.sessions.createAndSend.mutationOptions());
  const setProfileMut = useMutation(
    trpc.sessions.setProfile.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries(trpc.sessions.list.queryFilter()),
    }),
  );
  // Stop: cancel the agent(s) running on this session's channel (reuses the desktop Composer's
  // sessions.cancel path). `running` collapses to idle as the live stream quiets.
  const cancelMut = useMutation(trpc.sessions.cancel.mutationOptions());
  const onStop = (): void => {
    if (!sessionId || cancelMut.isPending) return;
    cancelMut.mutate({ sessionId });
  };
  // sec-7 message edit + rewind: submit fires the real `sessions.rewind` mutation; the transcript +
  // rail refetch on settle (and again on the `session.rewound` event / regeneration stream).
  const rewindMut = useMutation(trpc.sessions.rewind.mutationOptions({
    onSettled: () => {
      if (!sessionId) return;
      queryClient.invalidateQueries(trpc.sessions.transcript.queryFilter({ sessionId }));
      queryClient.invalidateQueries(trpc.sessions.list.queryFilter());
    },
  }));

  // ── local UI state ──
  const [text, setText] = useState('');
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [sessionIdOpen, setSessionIdOpen] = useState(false);
  // sec-7: long-press action menu (held row) · 7b edit mode (edited row) · 原消息 sheet.
  const [msgMenuIdx, setMsgMenuIdx] = useState<number | null>(null);
  // Where the held bubble was when the press fired — the 7a overlay floats its copy there.
  const [msgMenuAnchorTop, setMsgMenuAnchorTop] = useState<number | null>(null);
  const [editingRowIdx, setEditingRowIdx] = useState<number | null>(null);
  const [originalSheet, setOriginalSheet] = useState<{ text: string } | null>(null);
  // Composer text before the edit hijacked it — restored on × cancel (原样退出).
  const preEditText = useRef('');
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [contextUsageOpen, setContextUsageOpen] = useState(false);
  const [systemLines, setSystemLines] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftUploadId = useRef<string | null>(null);
  if (isDraft && !draftUploadId.current) draftUploadId.current = crypto.randomUUID();
  const uploadSessionId = isDraft ? (draftUploadId.current ?? '') : sessionId;

  // ── Per-session draft persistence (localStorage) ──
  // The composer text + successfully-uploaded attachments are persisted per scope so a draft survives
  // an app restart (stable webview origin) and a server restart (the referenced upload files live on
  // the server and are not wiped on boot). One effect LOADS on scope change and SAVES on content
  // change, distinguished by comparing the live key to a ref (shared logic with the desktop Composer).
  const draftKey = draftStorageKey({ isDraft, sessionId, projectId: currentProjectId });
  const draftKeyRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (draftKeyRef.current !== draftKey) {
      draftKeyRef.current = draftKey;
      if (!draftKey) return; // no stable scope (transient empty sessionId) → leave content untouched
      const d = loadDraft(draftKey);
      if (isDraft && d?.draftUploadId) draftUploadId.current = d.draftUploadId;
      setText(d?.text ?? '');
      const restored: PendingUpload[] = (d?.attachments ?? []).map((m) => ({
        id: nextId(),
        status: 'done' as const,
        progress: 100,
        meta: m,
        type: m.type,
      }));
      setUploads((prev) => {
        prev.forEach((u) => { if (u.previewUrl) URL.revokeObjectURL(u.previewUrl); });
        return restored;
      });
      return;
    }
    saveDraft(draftKey, {
      text,
      attachments: uploads.filter((u) => u.status === 'done' && u.meta).map((u) => u.meta!),
      ...(isDraft && draftUploadId.current ? { draftUploadId: draftUploadId.current } : {}),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, text, uploads, isDraft]);

  // Restored media attachments have no local File → fetch an authenticated object URL for the preview.
  useEffect(() => {
    let cancelled = false;
    uploads
      .filter((u) => !u.file && !u.previewUrl && u.status === 'done' && u.meta && (u.type === 'image' || u.type === 'video'))
      .forEach((u) => {
        fetchFileObjectUrl(u.meta!.path, 'inline')
          .then((url) => {
            if (cancelled) { URL.revokeObjectURL(url); return; }
            setUploads((prev) => prev.map((x) => (x.id === u.id ? { ...x, previewUrl: url } : x)));
          })
          .catch(() => { /* preview is best-effort */ });
      });
    return () => { cancelled = true; };
  }, [uploads]);

  const addFiles = (files: FileList | File[]): void => {
    const list = Array.from(files);
    for (const file of list) {
      const id = nextId();
      const type = classifyFileType(file);
      const previewUrl = type === 'image' || type === 'video' ? URL.createObjectURL(file) : undefined;
      setUploads((prev) => [...prev, { id, file, status: 'uploading', progress: 0, type, previewUrl }]);
      uploadFile(file, uploadSessionId, (pct) =>
        setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, progress: pct } : u))),
      )
        .then((meta) => setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, status: 'done', progress: 100, meta } : u))))
        .catch(() => setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, status: 'error' } : u))));
    }
  };

  const pickFiles = (accept: string, capture?: string): void => {
    const el = fileInputRef.current;
    if (!el) return;
    el.accept = accept;
    if (capture) el.setAttribute('capture', capture);
    else el.removeAttribute('capture');
    el.click();
  };

  const doneMetas = uploads.filter((u) => u.status === 'done' && u.meta).map((u) => u.meta!);
  const uploading = uploads.some((u) => u.status === 'uploading');
  const hasText = !!text.trim();

  // ── sec-7 edit mode (7b) ──
  const editingRow = editingRowIdx != null ? rows[editingRowIdx] : null;
  const editArmed = !!editingRow && editingRow.kind === 'user' && editingRow.turnIndex !== undefined;
  const cancelEdit = (): void => {
    setEditingRowIdx(null);
    setText(preEditText.current);
    preEditText.current = '';
  };
  const startEdit = (rowIndex: number): void => {
    const r = rows[rowIndex];
    if (!r || r.kind !== 'user' || r.turnIndex === undefined || running) return;
    preEditText.current = text;
    setRejectingId(null);
    setEditingRowIdx(rowIndex);
    setText(r.text);
  };
  // Disarm when the anchored row stops being an editable user row (transcript reshaped) or a turn
  // starts running (a scheduled/other-client message landed).
  useEffect(() => {
    if (editingRowIdx == null) return;
    const r = rows[editingRowIdx];
    const valid = !!r && r.kind === 'user' && r.turnIndex !== undefined;
    if (!valid || running) cancelEdit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, running, editingRowIdx]);
  const editing: MEditMode | null = editArmed
    ? { rowIndex: editingRowIdx!, ...rewindStats(rows, editingRowIdx!), onCancel: cancelEdit }
    : null;

  // ── sec-7 long-press menu (7a) ──
  const heldRow = msgMenuIdx != null ? rows[msgMenuIdx] : null;
  const msgMenu: MMsgMenu | null =
    heldRow && (heldRow.kind === 'user' || heldRow.kind === 'assistant')
      ? {
          rowIndex: msgMenuIdx!,
          anchorTop: msgMenuAnchorTop,
          onCopy: () => { void navigator.clipboard?.writeText(heldRow.text).catch(() => {}); },
          ...(heldRow.kind === 'user' && heldRow.turnIndex !== undefined
            ? { onEdit: () => startEdit(msgMenuIdx!), editDisabled: running || rewindMut.isPending }
            : {}),
          onClose: () => setMsgMenuIdx(null),
        }
      : null;

  // 5a reject / 5b free-text answer: the composer routes to the interaction, text required.
  const rejectArmed = !editArmed && !!rejectingId && rejectingId === pendingPlanId;
  const interactionMode = rejectArmed || !!pendingAskModel;
  const sendEnabled = editArmed
    ? hasText && !rewindMut.isPending
    : interactionMode
      ? hasText && !interactionActions.busy
      : (hasText || doneMetas.length > 0) && (!!sessionId || isDraft) && !uploading && !sendMut.isPending && !createAndSendMut.isPending;

  // A rejected send clears the composer optimistically too, so its content has to come back rather
  // than disappear with the row. Still on the same scope → merge it into the live composer (text
  // typed while the send was in flight is kept, below the restored text); moved on → merge it into
  // that scope's stored draft so it is there when the user returns.
  const restoreRejectedSend = (sent: ComposerDraft, sentKey: string | null, error: Error): void => {
    if (draftKeyRef.current !== sentKey) {
      saveDraft(sentKey, mergeRestoredDraft(loadDraft(sentKey) ?? { text: '', attachments: [] }, sent));
      return;
    }
    if (sent.draftUploadId) draftUploadId.current = sent.draftUploadId;
    setText((current) => [sent.text, current].filter((v) => v.length > 0).join('\n'));
    setUploads((prev) => [
      ...sent.attachments
        .filter((m) => !prev.some((u) => u.meta?.path === m.path))
        .map((m) => ({ id: nextId(), status: 'done' as const, progress: 100, meta: m, type: m.type })),
      ...prev,
    ]);
    setSystemLines((prev) => [...prev, lang === 'zh'
      ? `发送失败 · ${error.message} · 内容已退回输入框`
      : `send failed · ${error.message} · text restored to the composer`]);
  };

  const profileBackend = currentBackendOf(profiles, effectiveProfile);
  const slashProfiles = buildProfileOptions(profiles, effectiveProfile, {
    currentBackend: profileBackend,
    hasHistory: transcript.turns.length > 0 || liveTail.length > 0,
  }).map((profile) => ({ name: profile.name, detail: profile.sub, disabled: profile.disabled }));
  const slashAvailability = {
    newDisabled: uploading,
    cancelDisabled: !running || cancelMut.isPending,
    compactDisabled: !active?.contextCompactionSupported || compactAction.disabled || compactAction.pending,
    settingsDisabled: uploading,
  };
  const slashSuggestions = editArmed || rejectArmed || pendingAskModel
    ? []
    : buildSlashSuggestions(text, slashProfiles, slashAvailability);
  const slashHandlers: SlashActionHandlers = {
    onNew: () => navigate('/m/session/new'),
    onCancel: () => { if (running) onStop(); },
    onCompact: compactAction.onCompact,
    onProfile: onPickProfile,
    onSettings: () => navigate('/m/settings'),
  };
  const consumeSlashText = (): void => {
    saveDraft(draftKey, {
      text: '', attachments: doneMetas,
      ...(isDraft && draftUploadId.current ? { draftUploadId: draftUploadId.current } : {}),
    });
    setText('');
  };
  const executeSlashAction = (action: SlashAction): void => {
    consumeSlashText();
    runSlashAction(action, slashHandlers);
  };
  const handleSlashInput = (value: string): boolean => {
    const resolution = resolveSlashInput(value, slashProfiles, slashAvailability);
    if (resolution.kind === 'none') return false;
    if (resolution.kind === 'action') executeSlashAction(resolution.action);
    return true;
  };
  const onSlashPick = (suggestion: SlashSuggestion): void => {
    if (suggestion.disabled) return;
    if (suggestion.action) executeSlashAction(suggestion.action);
    else setText(`${suggestion.command} `);
  };

  const onSend = (): void => {
    const t = text.trim();
    // 7b — send = rewind to the edited turn and regenerate with the new text.
    if (editArmed) {
      if (!sendEnabled) return;
      const er = editingRow as Extract<typeof rows[number], { kind: 'user' }>;
      rewindMut.mutate({ sessionId, turnIndex: er.turnIndex!, text: t });
      setEditingRowIdx(null);
      setText(preEditText.current);
      preEditText.current = '';
      return;
    }
    // 5a — send = reject with the typed feedback (required).
    if (rejectArmed) {
      if (!sendEnabled) return;
      interactionActions.rejectPlan(rejectingId!, t);
      setRejectingId(null);
      setText('');
      return;
    }
    // 5b — typed text answers the CURRENT question of the pending ask card.
    if (pendingAskModel) {
      if (!sendEnabled) return;
      const st = askStateOf(pendingAskModel.requestId);
      const q = pendingAskModel.questions[currentQuestionIndex(pendingAskModel, st)];
      if (q) commitAndMaybeSubmit(pendingAskModel, commitAnswer(st, q.question, t));
      setText('');
      return;
    }
    if (handleSlashInput(t)) return;
    if (!sendEnabled) return;
    // The row is enqueued before the mutation is awaited, so the message is on screen on the same
    // frame the composer clears — the send no longer looks dropped while the server round-trips.
    const sent: ComposerDraft = {
      text: t,
      attachments: doneMetas,
      ...(isDraft && draftUploadId.current ? { draftUploadId: draftUploadId.current } : {}),
    };
    const sentKey = draftKey;
    const mutation = runOptimisticMutation<{ sessionId: string } | { accepted: boolean }>({
      message: optimistic.prepare(t, doneMetas),
      mutate: () => isDraft
        ? createAndSendMut.mutateAsync({
            projectId: currentProjectId ?? 'general',
            profileName: draftProfile ?? undefined,
            text: t,
            draftUploadId: sent.draftUploadId,
            ...(doneMetas.length > 0 ? { attachments: doneMetas } : {}),
          } as never)
        : sendMut.mutateAsync({ sessionId, text: t, ...(doneMetas.length > 0 ? { attachments: doneMetas } : {}) } as never),
      onEnqueue: optimistic.enqueue,
      onAccepted: (entry, data) => {
        if (!('sessionId' in data)) {
          optimistic.accept(entry.clientId);
          return;
        }
        optimistic.accept(entry.clientId, data.sessionId);
        setPendingCreatedSession({ sessionId: data.sessionId, profileName: draftProfile });
        queryClient.invalidateQueries(trpc.sessions.list.queryFilter());
        navigate(`/m/session/${data.sessionId}`, { replace: true });
      },
      onRejected: (entry) => optimistic.reject(entry.clientId),
    });
    // Draft consumed — drop the persisted copy and reset the draft upload dir for the next draft.
    clearDraft(draftKey);
    if (isDraft) draftUploadId.current = null;
    setText('');
    setUploads((prev) => {
      prev.forEach((u) => { if (u.previewUrl) URL.revokeObjectURL(u.previewUrl); });
      return [];
    });
    void mutation.then((result) => {
      if (!result.ok && result.restore) restoreRejectedSend(sent, sentKey, result.error);
    });
  };

  function onPickProfile(name: string): void {
    setProfileOpen(false);
    if (name === effectiveProfile) return;
    const from = effectiveProfile;
    const line = lang === 'zh'
      ? `profile 切换 ${from} → ${name} · 下一 turn 生效`
      : `profile ${from} → ${name} · takes effect next turn`;
    if (isDraft) {
      setDraftProfile(name);
      setSystemLines((prev) => [...prev, line]);
    } else if (sessionId) {
      setProfileMut.mutate(
        { sessionId, profileName: name },
        { onSuccess: () => setSystemLines((prev) => [...prev, line]) },
      );
    }
  }

  // Header status = running snapshot + real agent-turn count + current/last-turn elapsed + last-run
  // cost — same progressive readout as the desktop composer (running: time+turns; idle-after-a-turn:
  // +cost; fresh: bare idle). A draft or never-run session shows just `idle`. A pending interaction
  // overrides the whole line with the amber Agent 已暂停 state (scheme 5a/5b/6a).
  const cost = active?.costUsd ?? null;
  const hasRun = !isDraft && turns != null;
  const status = pendingInteraction
    ? interactionHeaderStatus(
        pendingInteraction.detail.kind,
        pendingAskModel ? currentQuestionIndex(pendingAskModel, askStateOf(pendingAskModel.requestId)) : 0,
        pendingAskModel?.questions.length ?? 1,
        lang,
      )
    : chatHeaderStatus(running, turns, elapsed, cost, hasRun);

  // ── interaction props for the view ──
  const intCopy = pickCopy(lang, M_INT_COPY);
  const interactions: MChatInteractions = {
    copy: intCopy,
    askState: askStateOf,
    onAskPick,
    onAskToggle,
    onAskConfirmMulti,
    onAskCustom: () => {}, // typed text already routes to the current question (5b placeholder)
    rejectingId: rejectArmed ? rejectingId : null,
    onApprove: (m) => interactionActions.approvePlan(m.requestId),
    onRejectStart: (m) => setRejectingId(m.requestId),
    onOpenRead,
    onCancelResume: interactionActions.cancelResume,
    resumeCancelled: interactionActions.resumeCancelled,
  };
  const rejectBar: MRejectBar | undefined = rejectArmed && pendingPlanModel
    ? {
        title: lang === 'zh'
          ? `驳回「${pendingPlanModel.title}」— 说明原因后发送`
          : `Rejecting "${pendingPlanModel.title}" — explain, then send`,
        chips: lang === 'zh'
          ? ['范围太大', '先做 dry-run', '成本超预期', '步骤顺序不对']
          : ['Scope too big', 'Dry-run first', 'Over budget', 'Wrong step order'],
        onChipTap: (chip) => setText((t) => (t ? `${t}${lang === 'zh' ? '；' : '; '}${chip}` : chip)),
        onCancel: () => setRejectingId(null),
      }
    : undefined;
  const composerPlaceholder = rejectArmed
    ? (lang === 'zh' ? '说明驳回原因…' : 'Reason for rejecting…')
    : pendingAskModel
      ? (lang === 'zh'
          ? `点选项，或直接输入回答 Q${Math.min(currentQuestionIndex(pendingAskModel, askStateOf(pendingAskModel.requestId)) + 1, pendingAskModel.questions.length)}…`
          : `Tap an option, or type your answer to Q${Math.min(currentQuestionIndex(pendingAskModel, askStateOf(pendingAskModel.requestId)) + 1, pendingAskModel.questions.length)}…`)
      : undefined;
  const title = isDraft
    ? (lang === 'zh' ? '新会话' : 'New session')
    : (runTitle ?? active?.label ?? active?.name ?? routeParam ?? '');
  // 8d hint above the composer: replying extracts the run into a normal session.
  const schedHint = isScheduledRun
    ? (lang === 'zh'
        ? '发送消息后提取为普通会话 · schedule 下次 run 不受影响'
        : 'Replying converts this run into a normal session · the schedule\'s next run is unaffected')
    : null;
  const attachmentsVM: PendingAttachmentVM[] = uploads.map((u) => ({ id: u.id, name: u.file?.name ?? u.meta?.name ?? 'file', progress: u.progress, status: u.status, type: u.type, previewUrl: u.previewUrl }));

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) addFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <MChatView
        title={title}
        status={status}
        rows={rows}
        copy={copy}
        onBack={() => navigate('/m/sessions')}
        moreOpen={moreOpen}
        onMoreToggle={() => setMoreOpen((o) => !o)}
        onMoreClose={() => setMoreOpen(false)}
        sessionIdOpen={sessionIdOpen}
        onSessionIdOpen={() => setSessionIdOpen(true)}
        onSessionIdClose={() => setSessionIdOpen(false)}
        cortexId={active?.name ?? null}
        backendUuid={active?.backendSessionId ?? null}
        inlineThreadCard={
          sessionId ? (
            <InlineThreadCard
              sessionId={sessionId}
              subthreadsLabel={lang === 'zh' ? '子线程' : 'sub-threads'}
              openLabel={lang === 'zh' ? '打开' : 'Open'}
            />
          ) : undefined
        }
        systemLines={schedHint ? [...systemLines, schedHint] : systemLines}
        interactions={interactions}
        rejectBar={rejectBar}
        editCopy={pickCopy(lang, EDIT_COPY)}
        msgMenu={msgMenu}
        onLongPress={(rowIndex, anchorTop) => { setMsgMenuAnchorTop(anchorTop); setMsgMenuIdx(rowIndex); }}
        editing={editing}
        onShowOriginal={(edited) => setOriginalSheet({ text: edited.originalText })}
        originalSheet={originalSheet ? { text: originalSheet.text, onClose: () => setOriginalSheet(null) } : null}
        streamKey={sessionId}
        composerValue={text}
        onComposerChange={setText}
        onSend={onSend}
        slashSuggestions={slashSuggestions}
        onSlashPick={onSlashPick}
        sendEnabled={sendEnabled}
        composerPlaceholder={composerPlaceholder}
        onStop={onStop}
        stopEnabled={!cancelMut.isPending}
        profileChipLabel={profileChipLabel(effectiveProfile, profiles)}
        onOpenProfile={() => setProfileOpen(true)}
        contextUsage={contextUsage}
        contextUsageSupported={!!active?.contextCompactionSupported}
        contextUsageLang={lang}
        contextCompactAction={active?.contextCompactionSupported ? compactAction : undefined}
        contextUsageOpen={contextUsageOpen}
        onContextUsageOpen={() => setContextUsageOpen(true)}
        onContextUsageClose={() => setContextUsageOpen(false)}
        attachments={attachmentsVM}
        onRemoveAttachment={(id) => setUploads((prev) => {
          const gone = prev.find((u) => u.id === id);
          if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
          return prev.filter((u) => u.id !== id);
        })}
        onPlus={() => setAttachMenuOpen((o) => !o)}
        attachMenuOpen={attachMenuOpen}
        onAttachClose={() => setAttachMenuOpen(false)}
        onCamera={() => pickFiles('image/*', 'environment')}
        onLibrary={() => pickFiles('image/*,video/*')}
        onFile={() => pickFiles('*/*')}
        profileSheet={
          profileOpen
            ? { items: buildProfileSheetItems(profiles, effectiveProfile), onClose: () => setProfileOpen(false), onPick: onPickProfile }
            : undefined
        }
      />
    </>
  );
}
