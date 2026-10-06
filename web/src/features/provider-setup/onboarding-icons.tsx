import type { ReactNode } from 'react';

function Icon({ size = 16, children }: { size?: number; children: ReactNode }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}
export const MonitorIcon = () => <Icon size={20}><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></Icon>;
export const ServerIcon = () => <Icon size={20}>
  <rect x="4" y="3" width="16" height="7" rx="2" /><rect x="4" y="14" width="16" height="7" rx="2" /><path d="M8 6.5h.01M8 17.5h.01" />
</Icon>;
export const DownloadIcon = () => <Icon><path d="M12 3v12m-4-4 4 4 4-4M5 17v4h14v-4" /></Icon>;
export const ChevronIcon = () => <Icon><path d="m9 5 7 7-7 7" /></Icon>;
export const BackIcon = () => <Icon size={14}><path d="m15 6-6 6 6 6" /></Icon>;
