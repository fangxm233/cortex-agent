// 1b 会话详情 — the mobile chat surface (scheme-mobile.dc.html 1b + in-chat states 1m/1n/1o/1p). A
// drill page (route /m/session/:sessionId; sessionId === 'new' ⇒ draft, lazy-create on first send).
// REUSES the desktop chat plumbing wholesale, re-chromed for mobile:
//   • transcript: sessions.transcript + buildTranscriptRows (+ live session.message tail)
//   • live sync : useSessionMessageLiveSync (snapshot+delta running / agent-turn count)
//   • send      : sessions.send, or sessions.createAndSend when a draft (attachments carried through)
//   • profile   : config.get profiles + session.profileName + sessions.setProfile (1p sheet)
//   • attach    : the desktop Composer's raw XHR upload → /api/attachments/upload (1o)
//
// HONEST GAPS (verified against agent-server/domain/ui-service/app-router.ts + @cortex-agent/ui-contract):
//   • per-session `$` cost — SessionInfo carries none → OMITTED (never fabricated).
//   • 1m agent-提问 (AskUserQuestion) + 1n Plan-审批 (ExitPlanMode) — the web tRPC contract exposes NO
//     interaction/question/plan procedure or DTO, and the desktop CenterChat renders no such card, so
//     there is NO real mobile-reachable per-session source. The card UI (AskQuestionCard /
//     PlanApprovalCard) is built + unit-tested against the real desktop-shaped inputs (MChatView), but
//     this container has nothing real to feed them, so `pendingQuestion` / `pendingPlan` stay undefined
//     — the cards never render from live data (honest stub; no fabrication). When the backend grows a
//     session-scoped interaction stream, wire it here and pass the two props.
//   • ⋯ 重命名/导出/归档 — no backend op → inert honest menu.
import { useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { useMobileProject } from '@/mobile/current-project';
import {
  buildTranscriptRows,
  resolveTurns,
  currentTurnElapsedMs,
  formatElapsed,
} from '@/features/workbench/transcript-vm';
import { useSessionMessageLiveSync } from '@/features/workbench/useSessionMessageLiveSync';
import { useThreadGetLiveSync } from '@/features/thread/useThreadGetLiveSync';
import { threadPill } from '@/features/workbench/thread-card-proto';
import { buildMobileStepper, zhDivider } from '@/mobile/screens/mobile-session-vm';
import { MobileThreadStepper } from '@/mobile/screens/MobileThreadStepper';
import type { AttachmentMeta } from '@/features/workbench/chat-content';
import { MChatView, type MChatCopy } from './MChatView';
import {
  chatHeaderStatus,
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
    attachCamera: '拍照',
    attachLibrary: '照片图库',
    attachFile: '选择文件',
    attachFootnote: '上传完成前发送置灰 · 附件落 uploads/ 由 agent 读取',
    attachPlaceholder: '补充说明…',
    profileTitle: 'Profile',
    profileSubtitle: '仅本会话 · 热更新',
    profileCurrent: '当前',
    profileFooter: '切换仅影响本会话后续 turn · 运行中线程不受影响 · 全局默认在设置',
    askPill: 'Agent 提问',
    answered: '✓ 已回答',
    defaultBadge: '默认',
    planPending: '计划待批',
    approve: '批准并执行',
    reject: '驳回并反馈',
    fromLabel: '来自',
    writeLabel: '批准写入',
  },
  en: {
    composerPh: 'Message, / for commands',
    toolCallsUnit: 'tool calls',
    menuRename: 'Rename',
    menuExport: 'Export',
    menuArchive: 'Archive',
    attachCamera: 'Take photo',
    attachLibrary: 'Photo library',
    attachFile: 'Choose file',
    attachFootnote: 'Send is disabled until uploads finish · files land in uploads/ for the agent',
    attachPlaceholder: 'Add a note…',
    profileTitle: 'Profile',
    profileSubtitle: 'This session · hot-swap',
    profileCurrent: 'current',
    profileFooter: 'Applies to this session’s next turns only · running threads unaffected · global default in Settings',
    askPill: 'Agent question',
    answered: '✓ answered',
    defaultBadge: 'default',
    planPending: 'Plan pending',
    approve: 'Approve & run',
    reject: 'Reject with note',
    fromLabel: 'from',
    writeLabel: 'writes to',
  },
};

// Inline experiment-pipeline thread card (scheme 1b L148-158), bound to REAL threads.get — same
// discipline as the desktop InlineThreadCardProto: the contract has no session→thread link, so we bind
// to the most-relevant active thread (first running, else first waiting). `打开 →` drills to 1g.
function InlineThreadCard({ subthreadsLabel, openLabel }: { subthreadsLabel: string; openLabel: string }): JSX.Element | null {
  const navigate = useNavigate();
  const trpc = useTRPC();
  const listQuery = useQuery(trpc.threads.list.queryOptions({ status: ['running', 'waiting'] }));
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
  file: File;
  status: 'uploading' | 'done' | 'error';
  progress: number;
  meta?: AttachmentMeta;
}

let _uid = 0;
const nextId = (): string => `att_${++_uid}_${Date.now()}`;

// Raw XHR upload (ported from the desktop Composer — module-private there). Plain HTTP + File API,
// works on mobile browsers. Returns the AttachmentMeta the send path references.
function uploadFile(file: File, sessionId: string, onProgress: (pct: number) => void): Promise<AttachmentMeta> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', UPLOAD_PATH);
    xhr.setRequestHeader('X-Session-Id', sessionId);
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
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
  const active = useMemo(
    () => (sessionsQuery.data ?? []).find((s) => s.sessionId === routeParam) ?? null,
    [sessionsQuery.data, routeParam],
  );
  const sessionId = isDraft ? '' : (active?.sessionId ?? routeParam ?? '');

  const transcriptQuery = useQuery({
    ...trpc.sessions.transcript.queryOptions({ sessionId }),
    enabled: !!sessionId,
  });
  const { liveTail, streaming, running, liveTurns } = useSessionMessageLiveSync(sessionId, active?.running);
  const transcript = transcriptQuery.data ?? EMPTY_TRANSCRIPT;
  const rows = useMemo(
    () => buildTranscriptRows(transcript, liveTail, { streaming, formatDivider: zhDivider }),
    [transcript, liveTail, streaming],
  );
  const turns = resolveTurns(liveTurns, active?.numTurns ?? null);
  const elapsed = useMemo(() => formatElapsed(currentTurnElapsedMs(transcriptQuery.data)), [transcriptQuery.data]);

  // ── profiles (1p) ──
  const configQuery = useQuery(trpc.config.get.queryOptions({}));
  const profiles = configQuery.data?.profiles?.profiles ?? [];
  const defaultProfile = configQuery.data?.profiles?.defaultProfile ?? null;
  const [draftProfile, setDraftProfile] = useState<string | null>(null);
  const effectiveProfile = effectiveProfileName(
    isDraft ? draftProfile : active?.profileName,
    profiles,
    defaultProfile,
  );

  // ── mutations ──
  const sendMut = useMutation(trpc.sessions.send.mutationOptions());
  const createAndSendMut = useMutation(
    trpc.sessions.createAndSend.mutationOptions({
      onSuccess: (data) => {
        queryClient.invalidateQueries(trpc.sessions.list.queryFilter());
        navigate(`/m/session/${data.sessionId}`, { replace: true });
      },
    }),
  );
  const setProfileMut = useMutation(
    trpc.sessions.setProfile.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries(trpc.sessions.list.queryFilter()),
    }),
  );

  // ── local UI state ──
  const [text, setText] = useState('');
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [systemLines, setSystemLines] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftUploadId = useRef<string | null>(null);
  if (isDraft && !draftUploadId.current) draftUploadId.current = crypto.randomUUID();
  const uploadSessionId = isDraft ? (draftUploadId.current ?? '') : sessionId;

  const addFiles = (files: FileList | File[]): void => {
    const list = Array.from(files);
    for (const file of list) {
      const id = nextId();
      setUploads((prev) => [...prev, { id, file, status: 'uploading', progress: 0 }]);
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
  const sendEnabled = (hasText || doneMetas.length > 0) && (!!sessionId || isDraft) && !uploading && !sendMut.isPending && !createAndSendMut.isPending;

  const onSend = (): void => {
    const t = text.trim();
    if (!sendEnabled) return;
    if (isDraft) {
      createAndSendMut.mutate({
        projectId: currentProjectId ?? 'general',
        profileName: draftProfile ?? undefined,
        text: t,
        draftUploadId: draftUploadId.current ?? undefined,
        ...(doneMetas.length > 0 ? { attachments: doneMetas } : {}),
      } as never);
    } else {
      sendMut.mutate({ sessionId, text: t, ...(doneMetas.length > 0 ? { attachments: doneMetas } : {}) } as never);
    }
    setText('');
    setUploads([]);
  };

  const onPickProfile = (name: string): void => {
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
  };

  const status = chatHeaderStatus(running, turns);
  const title = isDraft
    ? (lang === 'zh' ? '新会话' : 'New session')
    : (active?.label ?? active?.name ?? routeParam ?? '');
  const attachmentsVM: PendingAttachmentVM[] = uploads.map((u) => ({ id: u.id, name: u.file.name, progress: u.progress, status: u.status }));

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
        inlineThreadCard={
          <InlineThreadCard
            subthreadsLabel={lang === 'zh' ? '子线程' : 'sub-threads'}
            openLabel={lang === 'zh' ? '打开' : 'Open'}
          />
        }
        systemLines={systemLines}
        composerValue={text}
        onComposerChange={setText}
        onSend={onSend}
        sendEnabled={sendEnabled}
        profileChipLabel={profileChipLabel(effectiveProfile, profiles)}
        onOpenProfile={() => setProfileOpen(true)}
        runningLine={running ? `running · ${elapsed}` : undefined}
        attachments={attachmentsVM}
        onRemoveAttachment={(id) => setUploads((prev) => prev.filter((u) => u.id !== id))}
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
