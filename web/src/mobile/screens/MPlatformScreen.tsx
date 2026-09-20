// input:  runtime config query and shared platform editor
// output: mobile platform connection and runtime settings screen
// pos:    Mobile host for the shared Platform settings panel
// >>> Once updated, update this header and parent CORTEX.md <<<

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { PlatformPanel } from '@/features/settings/PlatformPanel';
import { MSettingsCard, MSettingsPage } from './MSettingsControls';

export function MPlatformScreen() {
  const L = useVocab();
  const trpc = useTRPC();
  const navigate = useNavigate();
  const [dirty, setDirty] = useState(false);
  const query = useQuery(trpc.config.get.queryOptions({}));
  const back = () => { if (!dirty || window.confirm(L.psUnsaved)) navigate('/m/settings'); };
  let content;
  if (query.isLoading) content = <MSettingsCard><p>{L.stLoadingConfig}</p></MSettingsCard>;
  else if (query.isError || !query.data) content = <MSettingsCard><p>{L.stFailedLoadConfig}</p></MSettingsCard>;
  else content = <PlatformPanel snapshot={query.data} onDirtyChange={setDirty} />;
  return <MSettingsPage title={L.stNavPlatform} onBack={back}>{content}</MSettingsPage>;
}
