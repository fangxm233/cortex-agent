// input:  shared machines resource, mobile navigation, copy and toast feedback
// output: single-expand mobile telemetry and registration-request screen
// pos:    Mobile Machines resource adapter
// >>> If I am updated, update my header comment and CORTEX.md <<<
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '@/design';
import { useLang, useVocab } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { MScreen, MC } from '@/mobile/ui/kit';
import {
  useMachinesResource,
  type MachineDetailResource,
  type MachinesResource,
} from '@/features/machines/useMachinesResource';
import { MMachinesView, type MMachinesCopy, type MMachineDetailPanel } from './MMachinesView';
import { buildMMachinesVm } from './m-machines-vm';

const COPY: { en: MMachinesCopy; zh: MMachinesCopy } = {
  en: {
    title: 'Machines',
    online: 'Online',
    offline: 'Offline',
    hb: 'HB',
    lastHb: 'last HB',
    gpu: 'GPU',
    running: 'running',
    daemon: 'daemon',
    onlineWord: 'online',
    retry: 'Retry',
    logs: 'Logs',
    registered: 'registered',
    editDesktop: 'edit on desktop',
    add: 'Add machine',
    empty: 'No machines',
    probing: 'Probing…',
    probeFailed: 'Probe failed',
    noGpu: 'No GPU reported',
    offlineNoTelemetry: 'Offline — no live telemetry',
    up: 'up',
    uptime: 'uptime',
    path: 'path',
  },
  zh: {
    title: '机器',
    online: '在线',
    offline: '离线',
    hb: '心跳',
    lastHb: '上次心跳',
    gpu: 'GPU',
    running: '运行中',
    daemon: 'daemon',
    onlineWord: '在线',
    retry: '重试连接',
    logs: '查看日志',
    registered: '台注册',
    editDesktop: '编辑走桌面设置',
    add: '添加机器',
    empty: '暂无机器',
    probing: '探测中…',
    probeFailed: '探测失败',
    noGpu: '未检测到 GPU',
    offlineNoTelemetry: '离线 — 无实时数据',
    up: '已连接',
    uptime: '运行时长',
    path: '路径',
  },
};

function detailPanel(detail: MachineDetailResource | undefined): MMachineDetailPanel | null {
  if (!detail || detail.status === 'offline') return null;
  if (detail.status === 'error') return { status: 'error', vm: null, uptime: '' };
  if (detail.status === 'probing') return { status: 'probing', vm: null, uptime: '' };
  return { status: 'ready', vm: detail.facts, uptime: detail.uptime };
}

function useAddMachine(resource: MachinesResource) {
  const L = useVocab();
  const { toast } = useToast();
  return async () => {
    const name = window.prompt(L.stAddMachinePrompt)?.trim();
    if (!name) return;
    try {
      await resource.requestAddMachine(name);
      toast({ title: L.stToastQueuedApproval, tone: 'waiting' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast({ title: `${L.stToastCouldNotQueue}: ${message}`, tone: 'failed' });
    }
  };
}

export function MMachinesScreen() {
  const navigate = useNavigate();
  const copy = pickCopy(useLang(), COPY);
  const [expanded, setExpanded] = useState<string | null>(null);
  const resource = useMachinesResource(expanded ? [expanded] : []);
  const vm = useMemo(() => buildMMachinesVm(resource.machines, Date.now()), [resource.machines]);
  const panel = detailPanel(expanded ? resource.detailFor(expanded) : undefined);
  const requestAdd = useAddMachine(resource);
  // retry-connect / view-logs remain inert: no browser-safe daemon operation exists.
  return <MScreen label="1k 机器">{resource.loading
    ? <div style={{ padding: 16, color: MC.muted, fontSize: 13 }}>{copy.empty}</div>
    : <MMachinesView vm={vm} copy={copy} onBack={() => navigate('/m/settings')}
      expanded={expanded} onToggle={(name) => setExpanded((old) => old === name ? null : name)}
      panel={panel} onAdd={requestAdd} addDisabled={resource.addPending} />}
  </MScreen>;
}
