// 1k 机器 — the machines registry, drilled from the project page (scheme 1e→1k). NON-Tab drill page
// (the shell hides the Tab bar for /m/machines). Real tRPC: `machines.list` — the joined view of
// machines.json (static config) + client-manager (live online state) + executionRegistry (running
// dispatch count). Back → the project page (1e). Editing the registry lives on desktop settings.
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { MachineInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { MScreen, MC } from '@/mobile/ui/kit';
import { MMachinesView, type MMachinesCopy } from './MMachinesView';
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
    empty: 'No machines',
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
  },
};

export function MMachinesScreen() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const lang = useLang();
  const copy = pickCopy(lang, COPY);
  const now = Date.now();

  const machinesQuery = useQuery(trpc.machines.list.queryOptions({}));
  const machines = useMemo<MachineInfo[]>(() => machinesQuery.data ?? [], [machinesQuery.data]);
  const vm = useMemo(() => buildMMachinesVm(machines, now), [machines, now]);

  // retry-connect / view-logs are inert here (守则11 no-fabrication): re-establishing a client
  // WebSocket or streaming a client's logs needs a daemon-side op with no browser-safe tRPC surface.
  // Left unwired (no-op) — mirrors the desktop settings machines pattern; registry edits go to desktop.
  return (
    <MScreen label="1k 机器">
      {machinesQuery.isLoading ? (
        <div style={{ padding: 16, color: MC.muted, fontSize: 13 }}>{copy.empty}</div>
      ) : (
        <MMachinesView vm={vm} copy={copy} onBack={() => navigate('/m/settings')} />
      )}
    </MScreen>
  );
}
