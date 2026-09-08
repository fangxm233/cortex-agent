// input:  setup controller, auth modal, native bridge and i18n
// output: standalone provider setup route and compact view
// pos:    New-install provider onboarding outside AppShell
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AuthAccountStatus, LoginFlowState } from '@cortex-agent/ui-contract';
import { Button } from '@/design';
import { useVocab, type Vocab } from '@/i18n';
import { useTRPCClient } from '@/lib/trpc';
import { LoginFlowModal, type LoginFlowTarget } from '@/features/auth/LoginFlowModal';
import { orderedProviders, ProviderSetupController } from './provider-setup';
import { canSetupClaude, setupClaude, claudeInstallLine } from './setup-native';
import { listenNativeEvent } from '@/lib/native-bridge';

const panel = 'rounded-card border border-proto-line-2 bg-surface-card p-2g';
function statusCopy(account: AuthAccountStatus, L: Vocab): string {
  return { 'logged-in': L.setupConfigured, expiring: L.setupExpiring,
    'logged-out': L.setupMissing, expired: L.setupExpired, unknown: L.setupUnknown }[account.state];
}
function AccountRow({ account, login, disabled }: {
  account: AuthAccountStatus; login: (target: LoginFlowTarget) => void; disabled: boolean;
}) {
  const L = useVocab();
  return <div className="flex flex-wrap items-center justify-between gap-1g border-b border-proto-line-2 py-1.5g">
    <div><div className="font-medium">{account.label}</div>
      <p className="text-caption text-state-muted">{statusCopy(account, L)}</p></div>
    <div className="flex gap-1g">{account.capabilities.map(authType => <Button key={authType}
      disabled={disabled} onClick={() => login({ backend: account.backend, provider: account.provider, authType })}>
      {authType === 'api_key' ? L.authLoginApiKey : L.authLoginOAuth}</Button>)}</div>
  </div>;
}
function useClaudeLog() {
  const [log, setLog] = useState('');
  useEffect(() => {
    if (!canSetupClaude()) return;
    let disposed = false;
    let stop = () => {};
    void listenNativeEvent('setup-log', payload => {
      const line = claudeInstallLine(payload);
      if (!disposed && line !== null) setLog(previous => `${previous}${line}\n`.slice(-6000));
    }).then(unlisten => { if (disposed) unlisten(); else stop = unlisten; });
    return () => { disposed = true; stop(); };
  }, []);
  return log;
}
function ClaudeSection({ controller, login }: {
  controller: ProviderSetupController; login: (target: LoginFlowTarget) => void;
}) {
  const L = useVocab();
  const s = controller.state;
  const log = useClaudeLog();
  const account = s.status?.accounts.find(a => a.backend === 'claude');
  const local = canSetupClaude();
  const start = async (target: LoginFlowTarget) => { if (await controller.prepareClaude()) login(target); };
  return <section className={panel}>
    <h2 className="font-semibold">{L.setupCc}</h2>
    <p className="text-caption text-state-muted">{s.claude === null ? L.setupUnknown : s.claude.installed ? `${L.setupCcInstalled} ${s.claude.version ?? ''}` : L.setupCcMissing}</p>
    {!local ? <p className="text-caption">{L.setupCcLocal}</p> : <>
      {s.claude === null ? <Button disabled={s.claudeBusy} onClick={controller.detectClaude}>{L.setupRetry}</Button> : null}
      {account && s.claude?.installed ? <AccountRow account={account} disabled={s.claudeBusy || s.busy} login={start} /> : null}
      {account && s.claude?.installed === false ? <><p className="text-caption text-state-muted">{L.setupCcConsent}</p>
        <Button disabled={s.claudeBusy || s.busy || !account.capabilities.length} onClick={() => start({ backend: 'claude', provider: account.provider, authType: account.capabilities[0]! })}>{L.setupCcInstall}</Button></> : null}
    </>}
    {s.claudeBusy ? <p role="status">{L.setupWorking}</p> : null}
    {log ? <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words text-caption">{log}</pre> : null}
    {s.claudeError ? <p role="alert" className="break-words text-state-fail">{s.claudeError}</p> : null}
  </section>;
}
function ProfileSection({ controller }: { controller: ProviderSetupController }) {
  const L = useVocab();
  const available = controller.available();
  const current = controller.state.profiles?.defaultProfile ?? '';
  const matching = available.some(p => p.name === current);
  return <section className={panel}>
    <label className="block font-semibold" htmlFor="setup-profile">{L.setupProfile}: {current || '—'}</label>
    {!matching ? <p className="my-1g text-caption text-state-muted">{available.length ? L.setupMismatch : L.setupNoProfiles}</p> : null}
    <select id="setup-profile" className="w-full rounded border border-proto-line-2 bg-surface-canvas-alt p-1g"
      disabled={controller.state.busy || !available.length} value={matching ? current : ''}
      onChange={event => void controller.select(event.target.value)}>
      <option value="" disabled>{L.setupChooseProfile}</option>
      {available.map(p => <option key={p.name} value={p.name}>{p.name} · {p.model} · {p.backend ?? 'claude'}</option>)}
    </select>
  </section>;
}
function SetupFooter({ controller, leave }: { controller: ProviderSetupController; leave: () => void }) {
  const L = useVocab();
  return <footer className="space-y-1g">
    <p className="text-caption text-state-muted">{L.setupSkipWarning}</p>
    <div className="flex justify-end gap-1g">
      <Button data-action="setup-skip" onClick={leave}>{L.setupSkip}</Button>
      <Button data-action="setup-continue" variant="primary" disabled={!controller.canContinue()}
        onClick={() => { if (controller.canContinue()) leave(); }}>{L.setupContinue}</Button>
    </div>
  </footer>;
}
function PiSection({ controller, login }: { controller: ProviderSetupController; login: (target: LoginFlowTarget) => void }) {
  const L = useVocab();
  const [search, setSearch] = useState('');
  const s = controller.state;
  return <section className={panel}>
    <h2 className="font-semibold">{L.setupPi} {s.status?.piRuntime.version}</h2>
    {s.status && !s.status.piRuntime.available ? <p role="alert">{L.setupRuntimeError}: {s.status.piRuntime.error}</p> : null}
    <input type="search" aria-label={L.setupSearch} placeholder={L.setupSearch} value={search}
      onChange={event => setSearch(event.target.value)} className="my-1g w-full rounded border border-proto-line-2 bg-surface-canvas-alt p-1g" />
    <div className="max-h-60 overflow-y-auto">{orderedProviders(s.status?.accounts ?? [], search).map(account =>
      <AccountRow key={account.provider} account={account} disabled={s.busy || !s.status?.piRuntime.available} login={login} />)}</div>
  </section>;
}
export function ProviderSetupView({ controller, leave }: { controller: ProviderSetupController; leave: () => void }) {
  const L = useVocab();
  const s = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [target, setTarget] = useState<LoginFlowTarget | null>(null);
  const flowChanged = useCallback((state: LoginFlowState) => {
    if (state.step === 'done') void controller.loginDone(state.flowId);
  }, [controller]);
  return <main className="min-h-screen overflow-y-auto bg-surface-canvas p-3g text-ui text-state-ink">
    <div className="mx-auto max-w-[640px] space-y-2g">
      <header><h1 className="text-body font-semibold">{L.setupTitle}</h1><p>{L.setupDescription}</p>
        <p className="mt-1g text-caption text-state-muted">{L.setupHonesty}</p></header>
      <PiSection controller={controller} login={setTarget} />
      <ClaudeSection controller={controller} login={setTarget} />
      <div><Button disabled={s.busy} onClick={controller.refresh}>{s.busy ? L.setupWorking : L.setupRescan}</Button>
        {s.sync === 'success' ? <p role="status">{L.setupSyncSuccess}</p> : null}
        {s.error ? <p role="alert" className="break-words text-state-fail">{L.setupSyncFailed}: {s.error}</p> : null}</div>
      <ProfileSection controller={controller} />
      <SetupFooter controller={controller} leave={leave} />
    </div>
    <LoginFlowModal open={!!target} target={target} onClose={() => setTarget(null)} onFlowStateChange={flowChanged} />
  </main>;
}
export function ProviderSetupPage() {
  const client = useTRPCClient();
  const navigate = useNavigate();
  const controller = useMemo(() => new ProviderSetupController({
    status: () => client.auth.status.query({}), config: () => client.config.get.query({}),
    sync: () => client.auth.syncGateway.mutate({}),
    select: name => client.config.set.mutate({ section: 'profiles', value: { defaultProfile: name } }),
    claude: () => setupClaude(false), install: () => setupClaude(true), canInstall: canSetupClaude,
  }), [client]);
  useEffect(() => { void controller.load(); }, [controller]);
  return <ProviderSetupView controller={controller} leave={() => navigate('/workbench', { replace: true })} />;
}
