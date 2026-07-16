// 1l 设置 — mobile v3 screen slot (scheme-mobile.dc.html). Placeholder body; filled by its own pass.
import { MScreen, MC } from '@/mobile/ui/kit';

export function MSettingsScreen() {
  return (
    <MScreen label="1l 设置">
      <div style={{ padding: 16, color: MC.muted, fontSize: 13 }}>1l 设置</div>
    </MScreen>
  );
}
