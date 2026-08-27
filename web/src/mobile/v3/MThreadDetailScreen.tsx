// input:  mobile route state, shared lightweight detail controller, document viewer, and copy
// output: routed mobile thread detail screen adapter
// pos:    Mobile route/artifact composition over the canonical thread resource lifecycle
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// Non-Tab page; ancestor breadcrumbs ride in React Router location state.
import { useCallback } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { useThreadDetailController } from '@/features/thread/useThreadDetailController';
import { useDocViewer } from '@/features/media/DocViewer';
import { docKindOf } from '@/features/media/doc-kind';
import { MScreen, MC } from '@/mobile/ui/kit';
import { MThreadDetailView, type MThreadDetailCopy } from './MThreadDetailView';
import { buildMThreadDetailVm, type MThreadTrailCrumb, type MThreadArtifactVm } from './m-thread-detail-vm';

const COPY: { en: MThreadDetailCopy; zh: MThreadDetailCopy } = {
  en: {
    pause: 'Pause',
    cancel: 'Cancel',
    artifacts: 'Artifacts',
    noArtifacts: 'No artifacts',
    pending: 'wait',
    depth: 'depth',
    status: { running: 'Running', waiting: 'Waiting', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' },
  },
  zh: {
    pause: '暂停',
    cancel: '取消',
    artifacts: '产物',
    noArtifacts: '暂无产物',
    pending: '待',
    depth: '深度',
    status: { running: '运行中', waiting: '等待', done: '完成', failed: '失败', cancelled: '已取消' },
  },
};

export function MThreadDetailScreen() {
  const { threadId = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const lang = useLang();
  const copy = pickCopy(lang, COPY);
  const trail = ((location.state as { trail?: MThreadTrailCrumb[] } | null)?.trail ?? []).filter(
    (t) => t.id !== threadId,
  );

  const onCancelled = useCallback(() => navigate('/m/threads'), [navigate]);
  const controller = useThreadDetailController({
    threadId, includeArtifactContent: false, onCancelled,
  });

  const { openDoc } = useDocViewer();
  const handleArtifactClick = useCallback((artifact: MThreadArtifactVm) => {
    const kind = docKindOf(artifact.filename);
    if (kind) {
      openDoc({ kind, name: artifact.filename, path: artifact.wsRelPath });
    }
  }, [openDoc]);

  if (controller.loading) {
    return (
      <MScreen label="1g 线程详情">
        <div style={{ padding: 16, color: MC.muted, fontSize: 13 }}>…</div>
      </MScreen>
    );
  }
  if (controller.error) {
    return (
      <MScreen label="1g 线程详情">
        <div
          style={{
            margin: 14,
            background: MC.failBg,
            border: `1px solid ${MC.failBorder}`,
            borderRadius: 10,
            padding: '10px 14px',
            fontSize: 12.5,
            color: MC.fail,
          }}
        >
          {threadId}: {controller.error.message}
        </div>
      </MScreen>
    );
  }

  if (!controller.detail) return null;
  const vm = buildMThreadDetailVm(controller.detail, trail, controller.now);
  return (
    <MThreadDetailView
      vm={vm}
      copy={copy}
      onBack={() => navigate(-1)}
      onMore={() => { /* rename/export/archive menu — out of 1g scope */ }}
      onCancel={controller.cancel}
      onArtifactClick={handleArtifactClick}
    />
  );
}
