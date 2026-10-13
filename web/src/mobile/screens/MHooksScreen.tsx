import { mobileHeaderBack } from '@/mobile/mobile-navigation';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { HooksOverview } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';
import { useHooksOverview } from '@/features/settings/controllers/useHooksController';
import { MSettingsQueryPage } from './MSettingsControls';
import { MHooksCount, MHooksView } from './MHooksView';
import { buildMHooksVm } from './m-hooks-vm';

const EMPTY_OVERVIEW: HooksOverview = { hooks: [], scripts: [], hooksDir: '' };

export function MHooksScreen() {
  const navigate = useNavigate();
  const L = useVocab();

  const hooks = useHooksOverview();
  const vm = useMemo(() => buildMHooksVm(hooks.data ?? EMPTY_OVERVIEW), [hooks.data]);

  // Which declaration sheet is open, held by key rather than by row so a refetch cannot strand a
  // stale object in state — the row is re-resolved from the current model on every render.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const sheetRow = useMemo(
    () => (openKey === null ? null : vm.groups.flatMap((g) => g.rows).find((r) => r.key === openKey) ?? null),
    [openKey, vm],
  );

  return (
    <MSettingsQueryPage title={L.stNavHooks} onBack={() => mobileHeaderBack(navigate, '/m/settings')} query={hooks}
      loadingText={L.hkLoading} errorText={L.hkLoadFailed}
      trailing={hooks.data ? <MHooksCount vm={vm} /> : undefined}>
      {() => <MHooksView vm={vm} sheetRow={sheetRow} onOpenHook={setOpenKey} onCloseSheet={() => setOpenKey(null)} />}
    </MSettingsQueryPage>
  );
}
