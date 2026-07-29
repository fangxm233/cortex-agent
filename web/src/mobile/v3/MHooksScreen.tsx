// input:  hooks.list query, language, navigation
// output: data-bound read-only mobile hooks screen
// pos:    Mobile hooks query and sheet-selection container
// >>> If I am updated, update my header comment and CORTEX.md <<<

// Drilled from 1l 设置 (`Hooks · N` row). NON-Tab drill page — the shell hides the Tab bar for
// /m/settings/hooks and hardware back returns to /m/settings (mobile-navigation PARENT_RULES).
// Real tRPC: `hooks.list` — the full registry read model (declaration + source + load order +
// mountsOn + scriptExists). Read-only by design: mutating a hook lives on desktop settings.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { HooksOverview } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { MScreen, MC } from '@/mobile/ui/kit';
import { MHooksView, type MHooksCopy } from './MHooksView';
import { buildMHooksVm } from './m-hooks-vm';

const COPY: { en: MHooksCopy; zh: MHooksCopy } = {
  en: {
    title: 'Hooks',
    enabledWord: 'enabled',
    countUnit: 'hooks',
    group: {
      agent: 'AGENT EVENTS',
      cc: 'CLAUDE CODE EVENTS',
      pi: 'PI EVENTS',
      cortex: 'CORTEX BUS EVENTS',
      template: 'TEMPLATE-SCOPED',
      other: 'OTHER EVENTS',
    },
    enabled: 'Enabled',
    disabled: 'Disabled',
    scriptMissing: 'script missing',
    empty: 'No mounted hooks',
    editDesktop: 'Edit on desktop',
    none: '—',
    secondUnit: 's',
    minuteUnit: 'min',
    field: {
      event: 'Event',
      matcher: 'Matcher',
      filters: 'Filters',
      script: 'Script',
      command: 'Command',
      run: 'Run',
      timeout: 'Timeout',
      backends: 'Backends',
      requiresTool: 'Requires tool',
      result: 'Result',
      blocking: 'Blocking',
      source: 'Source',
      version: 'Version',
      fileName: 'File',
      order: 'Load order',
      mountsOn: 'Mounts on',
      appliesAt: 'Applies',
      template: 'Template',
      phase: 'Phase',
    },
    applies: { 'next-agent': 'Next agent start', 'server-restart': 'Server restart' },
    sheetFooter: 'Read-only on mobile — edit on desktop',
  },
  zh: {
    title: '钩子',
    enabledWord: '已启用',
    countUnit: '条钩子',
    group: {
      agent: 'AGENT 事件',
      cc: 'CLAUDE CODE 事件',
      pi: 'PI 事件',
      cortex: 'CORTEX 总线事件',
      template: '模板内联',
      other: '其他事件',
    },
    enabled: '已启用',
    disabled: '已停用',
    scriptMissing: '脚本缺失',
    empty: '暂无已挂载钩子',
    editDesktop: '桌面编辑',
    none: '—',
    secondUnit: '秒',
    minuteUnit: '分钟',
    field: {
      event: '事件',
      matcher: '匹配',
      filters: '过滤条件',
      script: '脚本',
      command: '命令',
      run: '执行',
      timeout: '超时',
      backends: '后端',
      requiresTool: '限定工具',
      result: '结果',
      blocking: '阻塞',
      source: '来源',
      version: '版本',
      fileName: '文件',
      order: '加载顺序',
      mountsOn: '挂载到',
      appliesAt: '生效',
      template: '模板',
      phase: '阶段',
    },
    applies: { 'next-agent': '下次 agent 启动', 'server-restart': '需重启 server' },
    sheetFooter: '移动端只读 — 编辑请到桌面端',
  },
};

const EMPTY_OVERVIEW: HooksOverview = { hooks: [], scripts: [], hooksDir: '' };

export function MHooksScreen() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const lang = useLang();
  const copy = pickCopy(lang, COPY);

  const hooksQuery = useQuery(trpc.hooks.list.queryOptions({}));
  const vm = useMemo(() => buildMHooksVm(hooksQuery.data ?? EMPTY_OVERVIEW), [hooksQuery.data]);

  // Which declaration sheet is open, held by key rather than by row so a refetch cannot strand a
  // stale object in state — the row is re-resolved from the current model on every render.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const sheetRow = useMemo(
    () => (openKey === null ? null : vm.groups.flatMap((g) => g.rows).find((r) => r.key === openKey) ?? null),
    [openKey, vm],
  );

  return (
    <MScreen label="1l-h 钩子">
      {hooksQuery.isLoading ? (
        <div style={{ padding: 16, color: MC.muted, fontSize: 13 }}>{copy.title}</div>
      ) : (
        <MHooksView
          vm={vm}
          copy={copy}
          sheetRow={sheetRow}
          onBack={() => navigate('/m/settings')}
          onOpenHook={setOpenKey}
          onCloseSheet={() => setOpenKey(null)}
        />
      )}
    </MScreen>
  );
}
