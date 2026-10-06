import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVocab } from '@/i18n';
import { useConfigSnapshot } from '@/features/settings/controllers/useConfigSnapshot';
import { PlatformPanel } from '@/features/settings/panels/PlatformPanel';
import { useMobileLeaveGuard } from '@/mobile/mobile-navigation';
import { MSettingsQueryPage } from './MSettingsControls';

export function MPlatformScreen() {
  const L = useVocab();
  const navigate = useNavigate();
  const [dirty, setDirty] = useState(false);
  const config = useConfigSnapshot();
  const canLeave = useMobileLeaveGuard(dirty, L.psUnsaved);
  const back = () => { if (canLeave()) navigate('/m/settings'); };
  return <MSettingsQueryPage title={L.stNavPlatform} onBack={back} query={config}>
    {(snapshot) => <PlatformPanel snapshot={snapshot} onDirtyChange={setDirty} />}
  </MSettingsQueryPage>;
}
