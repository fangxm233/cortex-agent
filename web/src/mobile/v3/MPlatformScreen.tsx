// input:  redacted config snapshot and approval request mutation
// output: mobile platform status and approval-backed reconnect actions
// pos:    Mobile Platform settings screen
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ConfigEnvEntry } from '@cortex-agent/ui-contract';
import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { MC } from '@/mobile/ui/kit';
import {
  API_KEYS, DAEMON_KEYS, FEISHU_KEYS, SLACK_KEYS, envRow, hasAnyKey, indexEnv,
} from '@/features/settings/platform-env';
import { MSettingsButton, MSettingsCard, MSettingsPage, MSettingsRow } from './MSettingsControls';

function EnvRows({ env, keys }: { env: ConfigEnvEntry[]; keys: string[] }) {
  const index = indexEnv(env);
  return <>{keys.map((key, row) => {
    const value = envRow(index, key);
    return <MSettingsRow key={key} title={key} sub={value.display} last={row === keys.length - 1} />;
  })}</>;
}

function PlatformBlock(props: {
  name: string; present: boolean; env: ConfigEnvEntry[]; keys: string[];
  pending: boolean; reconnect: () => void;
}) {
  const L = useVocab();
  return <MSettingsCard title={props.name}>
    <MSettingsRow title={props.present ? L.stConfigured : L.stNotConfigured}
      trailing={<MSettingsButton disabled={props.pending} onClick={props.reconnect}>{L.stReconnect}</MSettingsButton>} />
    <EnvRows env={props.env} keys={props.keys} />
  </MSettingsCard>;
}

export function MPlatformScreen() {
  const L = useVocab();
  const trpc = useTRPC();
  const navigate = useNavigate();
  const { toast } = useToast();
  const query = useQuery(trpc.config.get.queryOptions({}));
  const reconnect = useMutation(trpc.approvals.request.mutationOptions({
    onSuccess: () => toast({ title: L.stToastQueuedApproval, tone: 'waiting' }),
    onError: (error) => toast({ title: `${L.stToastCouldNotQueue}: ${error.message}`, tone: 'failed' }),
  }));
  const env = query.data?.env ?? [];
  const tuiPresent = indexEnv(env).CORTEX_TUI?.present === true;
  const request = (platform: 'slack' | 'feishu') => reconnect.mutate({ kind: 'reconnect-platform', platform });
  if (query.isLoading) return <MSettingsPage title={L.stNavPlatform} onBack={() => navigate('/m/settings')}>
    <MSettingsCard><div style={{ padding: 13 }}>{L.stLoadingConfig}</div></MSettingsCard>
  </MSettingsPage>;
  if (query.isError) return <MSettingsPage title={L.stNavPlatform} onBack={() => navigate('/m/settings')}>
    <MSettingsCard><div style={{ padding: 13, color: MC.fail }}>{L.stFailedLoadConfig}</div></MSettingsCard>
  </MSettingsPage>;
  return <MSettingsPage title={L.stNavPlatform} onBack={() => navigate('/m/settings')}>
    <PlatformBlock name="Slack" present={hasAnyKey(env, 'SLACK_')} env={env} keys={SLACK_KEYS}
      pending={reconnect.isPending} reconnect={() => request('slack')} />
    <PlatformBlock name="飞书" present={hasAnyKey(env, 'FEISHU_')} env={env} keys={FEISHU_KEYS}
      pending={reconnect.isPending} reconnect={() => request('feishu')} />
    <MSettingsCard title={L.stApi}><EnvRows env={env} keys={API_KEYS} /></MSettingsCard>
    <MSettingsCard title={L.stTuiGateway}>
      <MSettingsRow title={L.stTuiGateway} sub={L.tuiDesc} last
        trailing={<span>{tuiPresent ? L.stConfigured : L.stNotConfigured}</span>} />
    </MSettingsCard>
    <MSettingsCard title={L.stDaemonNetwork}><EnvRows env={env} keys={DAEMON_KEYS} /></MSettingsCard>
  </MSettingsPage>;
}
