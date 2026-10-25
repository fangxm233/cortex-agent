import { useVocab } from '@/i18n';
import { Toggle } from '@/features/settings/ui/settings-ui';
import { autostartToggle, type AutostartController } from '@/features/settings/controllers/useAutostartController';

/** Start at login on the first page after install; Settings → Advanced offers it later. */
export function SetupAutostartCard({ controller }: { controller: AutostartController }) {
  const L = useVocab();
  if (!controller.state) return null;
  const onClick = autostartToggle(controller);
  return <section className="setup-card" data-setup-autostart data-setting-value={controller.state}>
    <div className="setup-card-header"><h2>{L.onbStartAtLogin}</h2>
      <span style={{ marginLeft: 'auto', display: 'flex' }}>
        <Toggle on={controller.state === 'on'} onClick={onClick} inert={!onClick} ariaLabel={L.onbStartAtLogin} /></span></div>
    <div className="setup-card-body">
      <p className="setup-hint">{controller.state === 'external' ? L.autostartExternal : L.autostartDesc}</p>
      {controller.failed ? <p role="alert" className="setup-error">{L.autostartFailed}</p> : null}</div>
  </section>;
}
