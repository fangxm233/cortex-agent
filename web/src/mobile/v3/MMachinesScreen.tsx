// 1k 机器 — the machines registry, drilled from the project page (scheme 1e→1k). NON-Tab drill page
// (the shell hides the Tab bar for /m/machines). Real tRPC: `machines.list` for the roster and
// `machines.detail` for the expanded card's live probe (GPU telemetry + host vitals + running runs).
// Back → the project page (1e). Editing the registry lives on desktop settings.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { MachineInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { MScreen, MC } from '@/mobile/ui/kit';
import { buildMachineDetailVm, formatUptime } from '@/features/workbench/machine-detail-vm';
import { MMachinesView, type MMachinesCopy, type MMachineDetailPanel } from './MMachinesView';
import { buildMMachinesVm } from './m-machines-vm';

const LIST_REFRESH_MS = 10_000;
const PROBE_REFRESH_MS = 5_000;

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

export function MMachinesScreen() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const lang = useLang();
  const copy = pickCopy(lang, COPY);
  const now = Date.now();
  const [expanded, setExpanded] = useState<string | null>(null);

  const machinesQuery = useQuery({
    ...trpc.machines.list.queryOptions({}),
    // Connect/disconnect is not pushed to the UI, so the roster is polled to stay honest.
    refetchInterval: LIST_REFRESH_MS,
  });
  const machines = useMemo<MachineInfo[]>(() => machinesQuery.data ?? [], [machinesQuery.data]);
  const vm = useMemo(() => buildMMachinesVm(machines, now), [machines, now]);

  // Probing is an RPC round trip to the device, so it runs only while a card is open — and never for
  // an offline machine, which can only time out.
  const expandedOnline = machines.some((m) => m.name === expanded && m.online);
  const detailQuery = useQuery({
    ...trpc.machines.detail.queryOptions({ machine: expanded ?? '' }),
    enabled: expandedOnline,
    refetchInterval: expandedOnline ? PROBE_REFRESH_MS : false,
  });

  const panel = useMemo<MMachineDetailPanel | null>(() => {
    if (!expandedOnline) return null;
    if (detailQuery.isError) return { status: 'error', vm: null, uptime: '' };
    if (!detailQuery.data) return { status: 'probing', vm: null, uptime: '' };
    return {
      status: 'ready',
      vm: buildMachineDetailVm(detailQuery.data, now),
      uptime: formatUptime(detailQuery.data.vitals?.uptimeSec ?? null),
    };
  }, [expandedOnline, detailQuery.isError, detailQuery.data, now]);

  // retry-connect / view-logs are inert here (守则11 no-fabrication): re-establishing a client
  // WebSocket or streaming a client's logs needs a daemon-side op with no browser-safe tRPC surface.
  // Left unwired (no-op) — mirrors the desktop settings machines pattern; registry edits go to desktop.
  return (
    <MScreen label="1k 机器">
      {machinesQuery.isLoading ? (
        <div style={{ padding: 16, color: MC.muted, fontSize: 13 }}>{copy.empty}</div>
      ) : (
        <MMachinesView
          vm={vm}
          copy={copy}
          onBack={() => navigate('/m/settings')}
          expanded={expanded}
          onToggle={(name) => setExpanded((prev) => (prev === name ? null : name))}
          panel={panel}
        />
      )}
    </MScreen>
  );
}
