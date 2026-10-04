import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { HooksOverview } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { MC } from '@/mobile/ui/kit';
import { MSettingsPage } from './MSettingsControls';
import { MHooksView } from './MHooksView';
import { buildMHooksVm } from './m-hooks-vm';

const EMPTY_OVERVIEW: HooksOverview = { hooks: [], scripts: [], hooksDir: '' };

export function MHooksScreen() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const L = useVocab();

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
    <>
      {hooksQuery.isLoading ? (
        <MSettingsPage title={L.stNavHooks} onBack={() => navigate('/m/settings')}>
          <div style={{ color: MC.muted, fontSize: 13 }}>{L.stNavHooks}</div>
        </MSettingsPage>
      ) : (
        <MHooksView
          vm={vm}
          sheetRow={sheetRow}
          onBack={() => navigate('/m/settings')}
          onOpenHook={setOpenKey}
          onCloseSheet={() => setOpenKey(null)}
        />
      )}
    </>
  );
}
